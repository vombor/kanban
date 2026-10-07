// `kanban plan`: a plan card's spec and breakdown, the user's approval, and the expansion into dev cards.
//
//   show <task-id>     the spec and the breakdown in the plan card's worktree, with its approval and expansion
//   check --file <f>   validates a breakdown file offline (the planner's self-check)
//   approve <task-id>  the user's approval marker, pinned to the breakdown's hash
//   expand <task-id>   Backlog dev cards through the normal create path (the kit's devAssignment), linked by the
//                      breakdown's dependencies; never starts a card. Needs the user's approval.
//   metrics            per plan: planner, duration, cost, cards, approval, reworks of its cards
//
// The decisions are pure in src/plans/; this file reads the board, the worktree and the plan index, and asks.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { readPlanSlugFromPrompt } from "../kits/plan-prompt";
import { measureCard } from "../kits/team/scoreboard/scoreboard-store";
import { createPipelineStateStore } from "../pipeline/pipeline-state";
import { type PlanBreakdown, parsePlanBreakdown, readPlanFiles } from "../plans/plan-breakdown";
import { checkPlanExpandable, hashPlanBreakdown, planExpansion } from "../plans/plan-expand";
import {
	createPlanIndexStore,
	type PlanApproval,
	type PlanCardMetrics,
	type PlanIndexStore,
	type PlanRecord,
} from "../plans/plan-index";
import { buildPlanMetrics } from "../plans/plan-metrics";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { createTask, linkTaskPairs } from "./task";

type JsonRecord = Record<string, unknown>;

export interface PlanCommandDependencies {
	index?: PlanIndexStore;
	/** The plan card's worktree, or null when it has none. */
	findWorktree?: (repoPath: string, card: RuntimeBoardCard) => Promise<string | null>;
	/** Asks the user to confirm on the terminal; false when nobody can answer (no TTY). */
	confirm?: (question: string, expected: string) => Promise<boolean>;
	/** The plan card's own metrics (card metrics); null when they can't be measured. */
	measure?: (workspaceId: string, taskId: string) => Promise<PlanCardMetrics | null>;
	createCard?: typeof createTask;
	linkCards?: typeof linkTaskPairs;
	randomUuid?: () => string;
	now?: () => Date;
}

interface PlanTarget {
	repoPath: string;
	workspaceId: string;
	state: RuntimeWorkspaceStateResponse;
}

interface LocatedPlan {
	card: RuntimeBoardCard;
	column: RuntimeBoardColumnId;
	record: PlanRecord | null;
	slug: string;
}

async function defaultFindWorktree(repoPath: string, card: RuntimeBoardCard): Promise<string | null> {
	const info = await getTaskWorkspacePathInfo({ cwd: repoPath, taskId: card.id, baseRef: card.baseRef });
	return info.exists ? info.path : null;
}

async function defaultConfirm(question: string, expected: string): Promise<boolean> {
	if (!process.stdin.isTTY) {
		return false;
	}
	const readline = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await readline.question(question)).trim() === expected;
	} finally {
		readline.close();
	}
}

async function defaultMeasure(workspaceId: string, taskId: string): Promise<PlanCardMetrics | null> {
	try {
		const { config } = await readPipelineConfig();
		const { metrics } = await measureCard({ taskId, workspaceId, config });
		return {
			measuredAt: new Date().toISOString(),
			agent: metrics.agent,
			provider: metrics.provider,
			model: metrics.model,
			wallMin: metrics.metrics.wallMin,
			activeMin: metrics.metrics.activeMin,
			costUSD: metrics.metrics.costUSD,
		};
	} catch {
		return null;
	}
}

async function loadPlanTarget(cwd: string, projectPath: string | undefined): Promise<PlanTarget> {
	const path = projectPath?.trim() ? resolveProjectInputPath(projectPath.trim(), cwd) : cwd;
	const context = await loadWorkspaceContext(path, { autoCreateIfMissing: false });
	// A read through the board lock: nothing is saved.
	const { state } = await mutateWorkspaceState(context.repoPath, (current) => ({
		board: current.board,
		value: null,
		save: false,
	}));
	return { repoPath: context.repoPath, workspaceId: context.workspaceId, state };
}

function findCard(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { card: RuntimeBoardCard; column: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, column: column.id };
		}
	}
	return null;
}

async function locatePlan(target: PlanTarget, index: PlanIndexStore, taskId: string): Promise<LocatedPlan> {
	const found = findCard(target.state, taskId);
	if (!found) {
		throw new Error(`Task ${taskId} is not on the board of ${target.repoPath}.`);
	}
	const role = resolveCardRole(found.card);
	if (role !== "plan") {
		throw new Error(`Task ${taskId} is a ${role} card, not a plan card.`);
	}
	const record = (await index.read(target.workspaceId)).plans[taskId] ?? null;
	const slug = record?.slug ?? readPlanSlugFromPrompt(found.card.prompt);
	if (!slug) {
		throw new Error(
			`Plan card ${taskId} names no docs/specs/<slug>.cards.json in its prompt and has no plan index entry.`,
		);
	}
	return { ...found, record, slug };
}

async function readPlanWorktreeFiles(
	target: PlanTarget,
	plan: LocatedPlan,
	findWorktree: NonNullable<PlanCommandDependencies["findWorktree"]>,
) {
	const worktreePath = await findWorktree(target.repoPath, plan.card);
	if (!worktreePath) {
		throw new Error(`Plan card ${plan.card.id} has no worktree (never started, or already Done).`);
	}
	return await readPlanFiles(worktreePath, plan.slug);
}

function formatBreakdown(breakdown: PlanBreakdown): string[] {
	const lines: string[] = [];
	if (breakdown.summary) {
		lines.push(breakdown.summary, "");
	}
	for (const card of breakdown.cards) {
		const after = card.dependsOn.length > 0 ? ` (after ${card.dependsOn.join(", ")})` : "";
		const group = card.parallelGroup ? ` [${card.parallelGroup}]` : "";
		lines.push(`- ${card.id}: ${card.title}${group}${after}`);
		for (const criterion of card.acceptanceCriteria) {
			lines.push(`    ✓ ${criterion}`);
		}
	}
	return lines;
}

export async function showPlan(
	input: { cwd: string; taskId: string; projectPath?: string },
	deps: PlanCommandDependencies = {},
): Promise<{ json: JsonRecord; text: string }> {
	const index = deps.index ?? createPlanIndexStore();
	const target = await loadPlanTarget(input.cwd, input.projectPath);
	const plan = await locatePlan(target, index, input.taskId);
	const files = await readPlanWorktreeFiles(target, plan, deps.findWorktree ?? defaultFindWorktree);
	const parsed = files.breakdownText === null ? null : parsePlanBreakdown(files.breakdownText, plan.slug);
	const sha = files.breakdownText === null ? null : hashPlanBreakdown(files.breakdownText);
	const approval = plan.record?.approval ?? null;
	const approvalState = !approval ? "not approved" : approval.breakdownSha256 === sha ? "approved" : "stale";
	const text = [
		`Plan ${plan.card.id} (${plan.column}): ${plan.card.title ?? ""}`,
		`Approval: ${approval ? `${approvalState} at ${approval.at} via ${approval.via}` : "not approved"}`,
		`Expansion: ${plan.record?.expansion ? `${plan.record.expansion.status} (${Object.keys(plan.record.expansion.cards).length} cards)` : "none"}`,
		"",
		`=== ${files.paths.specPath} ===`,
		files.spec ?? "(missing)",
		"",
		`=== ${files.paths.breakdownPath} ===`,
		...(parsed === null
			? ["(missing)"]
			: parsed.ok
				? formatBreakdown(parsed.breakdown)
				: ["INVALID:", ...parsed.issues.map((issue) => `  ${issue}`)]),
	].join("\n");
	return {
		text,
		json: {
			ok: true,
			taskId: plan.card.id,
			column: plan.column,
			slug: plan.slug,
			worktreePath: files.paths.worktreePath,
			specPath: files.paths.specPath,
			breakdownPath: files.paths.breakdownPath,
			spec: files.spec,
			breakdown: parsed?.ok ? parsed.breakdown : null,
			issues: parsed && !parsed.ok ? parsed.issues : [],
			approval: approval ? { ...approval, state: approvalState } : null,
			expansion: plan.record?.expansion ?? null,
		},
	};
}

/** Reads and validates the plan card's breakdown; throws with every issue when it doesn't validate. */
async function readValidBreakdown(
	target: PlanTarget,
	plan: LocatedPlan,
	findWorktree: NonNullable<PlanCommandDependencies["findWorktree"]>,
): Promise<{ breakdown: PlanBreakdown; sha: string; specPath: string; specExists: boolean }> {
	const files = await readPlanWorktreeFiles(target, plan, findWorktree);
	if (files.breakdownText === null) {
		throw new Error(`Plan ${plan.card.id} has no ${files.paths.breakdownPath} in its worktree.`);
	}
	const parsed = parsePlanBreakdown(files.breakdownText, plan.slug);
	if (!parsed.ok) {
		throw new Error(`The breakdown ${files.paths.breakdownPath} is invalid: ${parsed.issues.join("; ")}`);
	}
	return {
		breakdown: parsed.breakdown,
		sha: hashPlanBreakdown(files.breakdownText),
		specPath: files.paths.specPath,
		specExists: files.spec !== null,
	};
}

async function writeApproval(
	index: PlanIndexStore,
	target: PlanTarget,
	plan: LocatedPlan,
	approval: PlanApproval,
	now: Date,
): Promise<void> {
	await index.update(target.workspaceId, (current) => {
		const existing = current.plans[plan.card.id];
		const record: PlanRecord = existing ?? {
			// A plan card made by hand (no `task create --role plan`) gets its entry on first approval.
			taskId: plan.card.id,
			slug: plan.slug,
			title: plan.card.title ?? "",
			createdAt: new Date(plan.card.createdAt || now.getTime()).toISOString(),
			kit: "unknown",
			agentId: plan.card.agentId ?? null,
			providerId: plan.card.agentSettings?.providerId ?? null,
			modelId: plan.card.agentSettings?.modelId ?? null,
			startInPlanMode: plan.card.startInPlanMode,
			approval: null,
			expansion: null,
			metrics: null,
		};
		return { ...current, plans: { ...current.plans, [plan.card.id]: { ...record, approval } } };
	});
}

export async function approvePlan(
	input: { cwd: string; taskId: string; projectPath?: string },
	deps: PlanCommandDependencies = {},
): Promise<JsonRecord> {
	const index = deps.index ?? createPlanIndexStore();
	const now = (deps.now ?? (() => new Date()))();
	const target = await loadPlanTarget(input.cwd, input.projectPath);
	const plan = await locatePlan(target, index, input.taskId);
	if (plan.record?.expansion?.status === "done") {
		throw new Error(`Plan ${plan.card.id} was already expanded.`);
	}
	if (plan.column !== "review") {
		throw new Error(`Plan ${plan.card.id} is in ${plan.column}; approve it once its planner has finished (Review).`);
	}
	const { breakdown, sha } = await readValidBreakdown(target, plan, deps.findWorktree ?? defaultFindWorktree);
	const approval: PlanApproval = { at: now.toISOString(), via: "approve", breakdownSha256: sha };
	await writeApproval(index, target, plan, approval, now);
	return { ok: true, taskId: plan.card.id, slug: plan.slug, cards: breakdown.cards.length, approval };
}

export async function expandPlan(
	input: { cwd: string; taskId: string; projectPath?: string; dryRun?: boolean; approvedByUser?: boolean },
	deps: PlanCommandDependencies = {},
): Promise<JsonRecord> {
	const index = deps.index ?? createPlanIndexStore();
	const now = deps.now ?? (() => new Date());
	const createCard = deps.createCard ?? createTask;
	const linkCards = deps.linkCards ?? linkTaskPairs;
	const dryRun = input.dryRun === true;
	const target = await loadPlanTarget(input.cwd, input.projectPath);
	const plan = await locatePlan(target, index, input.taskId);
	const { breakdown, sha, specPath, specExists } = await readValidBreakdown(
		target,
		plan,
		deps.findWorktree ?? defaultFindWorktree,
	);
	const check = checkPlanExpandable({
		taskId: plan.card.id,
		role: resolveCardRole(plan.card),
		column: plan.column,
		record: plan.record,
		breakdownSha256: sha,
		approvedByUser: input.approvedByUser === true,
		dryRun,
	});
	if (!check.ok) {
		throw new Error(check.error);
	}
	const boardTaskIds = new Set(target.state.board.columns.flatMap((column) => column.cards.map((card) => card.id)));
	const previous = plan.record?.expansion?.breakdownSha256 === sha ? plan.record.expansion : null;
	const planned = planExpansion({
		breakdown,
		planTaskId: plan.card.id,
		specPath,
		boardTaskIds,
		previous,
		randomUuid: deps.randomUuid ?? (() => globalThis.crypto.randomUUID()),
	});
	const summary = {
		taskId: plan.card.id,
		slug: plan.slug,
		specPath,
		...(specExists ? {} : { warning: `${specPath} is missing from the plan card's worktree` }),
		cards: planned.cards.map((card) => ({
			localId: card.localId,
			taskId: card.taskId,
			title: card.title,
			...(card.exists ? { existed: true } : {}),
		})),
		links: planned.links.map((link) => ({
			waiting: planned.taskIds[link.waiting],
			prerequisite: planned.taskIds[link.prerequisite],
		})),
	};
	if (dryRun) {
		return { ok: true, dryRun: true, approved: check.approval !== null, ...summary };
	}

	let approval = check.approval;
	if (check.needsApproval) {
		const confirmed = await (deps.confirm ?? defaultConfirm)(
			`The user approves the breakdown of plan ${plan.card.id} (${breakdown.cards.length} cards)? Type the plan's task id to confirm: `,
			plan.card.id,
		);
		if (!confirmed) {
			throw new Error(
				`Not confirmed: --approved-by-user needs the user to type the plan's task id on a terminal. Without one, the user runs kanban plan approve ${plan.card.id}.`,
			);
		}
		approval = { at: now().toISOString(), via: "expand", breakdownSha256: sha };
		await writeApproval(index, target, plan, approval, now());
	}

	const startedAt = now().toISOString();
	// The ids go into the index before the first card exists, so a resumed expand reuses them.
	await index.update(target.workspaceId, (current) => {
		const record = current.plans[plan.card.id];
		if (!record) {
			throw new Error(`Plan ${plan.card.id} has no plan index entry.`);
		}
		return {
			...current,
			plans: {
				...current.plans,
				[plan.card.id]: {
					...record,
					expansion: {
						status: "creating",
						startedAt: previous?.startedAt ?? startedAt,
						finishedAt: null,
						breakdownSha256: sha,
						cards: planned.taskIds,
						links: planned.links,
					},
				},
			},
		};
	});

	const created: JsonRecord[] = [];
	// Backlog shows the newest card on top: created last to first, the first card of the breakdown is on top.
	for (const card of [...planned.cards].reverse()) {
		if (card.exists) {
			continue;
		}
		// The normal create path: the kit's devAssignment picks the agent and model, as for any new dev card.
		const result = await createCard({
			cwd: input.cwd,
			projectPath: target.repoPath,
			taskId: card.taskId,
			title: card.title,
			prompt: card.prompt,
			baseRef: plan.card.baseRef,
			role: "dev",
		});
		created.push({ localId: card.localId, ...((result.task as JsonRecord | undefined) ?? {}) });
	}
	const linked = await linkCards({
		cwd: input.cwd,
		projectPath: target.repoPath,
		pairs: planned.links.map((link) => ({
			waitingTaskId: planned.taskIds[link.waiting] as string,
			prerequisiteTaskId: planned.taskIds[link.prerequisite] as string,
		})),
	});
	const metrics = await (deps.measure ?? defaultMeasure)(target.workspaceId, plan.card.id);
	const finishedAt = now().toISOString();
	await index.update(target.workspaceId, (current) => {
		const record = current.plans[plan.card.id];
		if (!record?.expansion) {
			return current;
		}
		return {
			...current,
			plans: {
				...current.plans,
				[plan.card.id]: { ...record, expansion: { ...record.expansion, status: "done", finishedAt }, metrics },
			},
		};
	});
	return {
		ok: true,
		...summary,
		approval,
		created: created.reverse(),
		linksAdded: linked.added.length,
		linksSkipped: linked.skipped,
		note: "The cards are in Backlog and not started: the orchestrator starts them.",
	};
}

export async function planMetrics(
	input: { cwd: string; projectPath?: string },
	deps: Pick<PlanCommandDependencies, "index"> = {},
): Promise<JsonRecord> {
	const index = deps.index ?? createPlanIndexStore();
	const path = input.projectPath?.trim() ? resolveProjectInputPath(input.projectPath.trim(), input.cwd) : input.cwd;
	const context = await loadWorkspaceContext(path, { autoCreateIfMissing: false });
	const [plans, pipelineState] = await Promise.all([
		index.read(context.workspaceId),
		createPipelineStateStore().peek(context.workspaceId),
	]);
	return { ok: true, workspaceId: context.workspaceId, plans: buildPlanMetrics(plans, pipelineState) };
}

export async function checkPlanFile(input: { file: string; slug?: string }): Promise<JsonRecord> {
	const parsed = parsePlanBreakdown(await readFile(input.file, "utf8"), input.slug);
	return parsed.ok
		? { ok: true, file: input.file, slug: parsed.breakdown.slug, cards: parsed.breakdown.cards.length }
		: { ok: false, file: input.file, issues: parsed.issues };
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function runPlanCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		const result = await handler();
		printJson(result);
		if (result.ok === false) {
			process.exitCode = 1;
		}
	} catch (error) {
		printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	}
}

export function registerPlanCommand(program: Command): void {
	const plan = program
		.command("plan")
		.description(
			"Plan cards (role plan): show a plan's spec and card breakdown, approve it, expand it into Backlog dev cards.",
		);

	plan
		.command("show")
		.description("Print the plan card's spec and card breakdown (from its worktree), its approval and expansion.")
		.argument("<task-id>", "The plan card.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--json", "Print as JSON.")
		.action(async (taskId: string, options: { projectPath?: string; json?: boolean }) => {
			try {
				const shown = await showPlan({ cwd: process.cwd(), taskId, projectPath: options.projectPath });
				if (options.json) {
					printJson(shown.json);
				} else {
					process.stdout.write(`${shown.text}\n`);
				}
			} catch (error) {
				process.stderr.write(`kanban plan show: ${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			}
		});

	plan
		.command("check")
		.description("Validate a card breakdown file (docs/specs/<slug>.cards.json); writes nothing.")
		.requiredOption("--file <path>", "The breakdown file.")
		.option("--slug <slug>", "The slug it must have.")
		.action(async (options: { file: string; slug?: string }) => {
			await runPlanCommand(
				async () => await checkPlanFile({ file: resolve(process.cwd(), options.file), slug: options.slug }),
			);
		});

	plan
		.command("approve")
		.description(
			"The user's approval of a plan card's breakdown (the plan card must be in Review). Only the user runs this: it is what lets the orchestrator expand the plan.",
		)
		.argument("<task-id>", "The plan card.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (taskId: string, options: { projectPath?: string }) => {
			await runPlanCommand(
				async () => await approvePlan({ cwd: process.cwd(), taskId, projectPath: options.projectPath }),
			);
		});

	plan
		.command("expand")
		.description(
			"Create the approved breakdown's cards in Backlog (the kit's devAssignment applies), link them by their dependencies and record the mapping. Never starts a card.",
		)
		.argument("<task-id>", "The plan card (in Review, approved by the user).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--dry-run", "Validate and print the cards and links; write nothing.")
		.option(
			"--approved-by-user",
			"The user approves it now: asks the user to confirm on the terminal (type the plan's task id).",
		)
		.action(async (taskId: string, options: { projectPath?: string; dryRun?: boolean; approvedByUser?: boolean }) => {
			await runPlanCommand(
				async () =>
					await expandPlan({
						cwd: process.cwd(),
						taskId,
						projectPath: options.projectPath,
						dryRun: options.dryRun,
						approvedByUser: options.approvedByUser,
					}),
			);
		});

	plan
		.command("metrics")
		.description(
			"Per plan card: planner agent and model, duration, cost, cards produced, approval, reworks of its cards.",
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { projectPath?: string }) => {
			await runPlanCommand(async () => await planMetrics({ cwd: process.cwd(), projectPath: options.projectPath }));
		});
}
