// `kanban plan`: a plan card's spec and breakdown, the user's approval, and the expansion into dev cards.
//
//   show <task-id>     the spec and the breakdown in the plan card's worktree, with its approval and expansion
//   check --file <f>   validates a breakdown file offline (the planner's self-check)
//   approve <task-id>  the user's approval marker, pinned to the breakdown's hash: asked of the running server, which
//                      refuses agent sessions and records it for the user at once
//   expand <task-id>   Backlog dev cards through the normal create path (the kit's devAssignment), linked by the
//                      breakdown's dependencies; never starts a card. Needs the user's approval.
//   metrics            per plan: planner, duration, cost, cards, approval, reworks of its cards
//
// The decisions are pure in src/plans/; this file reads the board, the worktree and the plan index, and asks. The
// approval is the user's in every isolation mode, so it is never written in-process: the runtime route
// (src/trpc/plans-api.ts) records it for the user and refuses every agent session.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { resolveCardRole } from "../core/card-role";
import { measureCard } from "../kits/team/scoreboard/scoreboard-store";
import { createPipelineStateStore } from "../pipeline/pipeline-state";
import { type PlanBreakdown, parsePlanBreakdown } from "../plans/plan-breakdown";
import { checkPlanExpandable, hashPlanBreakdown, planExpansion } from "../plans/plan-expand";
import {
	createPlanIndexStore,
	type PlanApproval,
	type PlanCardMetrics,
	type PlanIndexStore,
} from "../plans/plan-index";
import { buildPlanMetrics } from "../plans/plan-metrics";
import {
	describePlanApprovalState,
	type FindPlanWorktree,
	findPlanWorktree,
	type LocatedPlan,
	loadPlanTarget,
	locatePlan,
	type PlanTarget,
	readPlanWorktreeFiles,
	readValidBreakdown,
} from "../plans/plan-target";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext } from "../state/workspace-state";
import { createRuntimeTrpcClient, type RuntimeTrpcClient } from "./runtime-trpc-client";
import { createTask, linkTaskPairs } from "./task";

type JsonRecord = Record<string, unknown>;

/** The runtime calls of an approval: the plan route. */
export type PlanApprovalClient = Pick<RuntimeTrpcClient, "plans">;

export interface PlanCommandDependencies {
	index?: PlanIndexStore;
	/** The plan card's worktree, or null when it has none. */
	findWorktree?: FindPlanWorktree;
	/** The running server, scoped to the plan's workspace (default: a CLI runtime client). */
	createClient?: (workspaceId: string) => PlanApprovalClient;
	/** The plan card's own metrics (card metrics); null when they can't be measured. */
	measure?: (workspaceId: string, taskId: string) => Promise<PlanCardMetrics | null>;
	createCard?: typeof createTask;
	linkCards?: typeof linkTaskPairs;
	randomUuid?: () => string;
	now?: () => Date;
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
	const files = await readPlanWorktreeFiles(target, plan, deps.findWorktree ?? findPlanWorktree);
	const parsed = files.breakdownText === null ? null : parsePlanBreakdown(files.breakdownText, plan.slug);
	const sha = files.breakdownText === null ? null : hashPlanBreakdown(files.breakdownText);
	const approval = plan.record?.approval ?? null;
	const approvalState = describePlanApprovalState(approval, sha);
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

/**
 * Asks the running server for the user's approval (src/trpc/plans-api.ts): it refuses an agent session and records
 * the approval of anyone its strict caller lookup takes for the user. Returns the recorded approval; throws when it
 * was refused.
 */
export async function requestPlanApproval(
	input: {
		target: PlanTarget;
		plan: LocatedPlan;
		via: PlanApproval["via"];
		/** The breakdown this command read; the server refuses another one. */
		breakdownSha256: string | null;
	},
	deps: Pick<PlanCommandDependencies, "createClient">,
): Promise<{ approval: PlanApproval; cards: number }> {
	const taskId = input.plan.card.id;
	const client = (deps.createClient ?? createRuntimeTrpcClient)(input.target.workspaceId);
	const requested = await Promise.resolve()
		.then(() => client.plans.approve.mutate({ taskId, via: input.via, breakdownSha256: input.breakdownSha256 }))
		.catch((error: unknown) => {
			throw new Error(
				`Plan approval goes through the running Kanban server, which could not be reached: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	if (!requested.ok || !requested.approval) {
		throw new Error(requested.error ?? `Plan ${taskId} was not approved.`);
	}
	return { approval: requested.approval, cards: requested.plan?.cards ?? 0 };
}

export async function approvePlan(
	input: { cwd: string; taskId: string; projectPath?: string },
	deps: PlanCommandDependencies = {},
): Promise<JsonRecord> {
	const index = deps.index ?? createPlanIndexStore();
	const target = await loadPlanTarget(input.cwd, input.projectPath);
	const plan = await locatePlan(target, index, input.taskId);
	// The server checks the plan (Review, a valid breakdown, not expanded) before it records the approval.
	const { approval, cards } = await requestPlanApproval({ target, plan, via: "approve", breakdownSha256: null }, deps);
	return { ok: true, taskId: plan.card.id, slug: plan.slug, cards, approval };
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
	const valid = await readValidBreakdown(target, plan, deps.findWorktree ?? findPlanWorktree);
	const { breakdown, sha, specPath } = valid;
	const specExists = valid.spec !== null;
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
		// --approved-by-user: the same user-only approval as `kanban plan approve`, for exactly this breakdown.
		approval = (await requestPlanApproval({ target, plan, via: "expand", breakdownSha256: sha }, deps)).approval;
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
			"The user's approval of a plan card's breakdown (the plan card must be in Review), or use Approve plan on the board. Only the user: the Kanban server refuses agent sessions. It is what lets the orchestrator expand the plan.",
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
			"The user approves it now, as kanban plan approve does (refused for agent sessions).",
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
