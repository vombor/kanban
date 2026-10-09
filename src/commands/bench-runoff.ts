// `kanban bench runoff create|status` and `kanban bench tiers`: the team kit's runoffs and tiers features for people
// (plan §2.3, §3.2). `runoff create` makes one dev card per model on the same task and base and records the group in
// `<home>/data/<ws>/runoffs.json`; the pipeline's runoffs feature holds each PASS and decides. `tiers` prints the
// workspace kit's model tiers and what the tier lookup picks.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import type { RuntimeAgentId, RuntimeBoardCard, RuntimeBoardColumnId } from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { readSessionCredential } from "../isolation/cli-scope";
import { decideCardRouting } from "../kits/card-routing-check";
import { resolveProposalProvider } from "../kits/dev-assignment";
import { resolveKitRole } from "../kits/kit-roles";
import type { KitDocument } from "../kits/kit-schema";
import { loadKitCatalog, resolveKitByName, resolveWorkspaceKit } from "../kits/resolve-kit";
import {
	buildRunoffEntry,
	getTierContenders,
	parseRunoffModelSpec,
	planRunoffCards,
	type RunoffContender,
} from "../kits/team/runoffs/runoff-create";
import { isOpenRunoff, type RunoffEntry, readRunoffs, updateRunoffs } from "../kits/team/runoffs/runoffs-store";
import { buildTiersReport, formatTiersReport } from "../kits/team/tiers/tiers-report";
import { readPipelineHold } from "../pipeline/hold";
import { createPipelineStateStore } from "../pipeline/pipeline-state";
import { getWatchdogWorkspacePaths } from "../state/kanban-home";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { createTask, startTask } from "./task";
import { resolveWorkspaceTarget, type WorkspaceTarget } from "./workspace-target";

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function collect(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

async function resolveKit(target: WorkspaceTarget, kitName: string | undefined) {
	const [{ config }, catalog] = await Promise.all([readPipelineConfig(), loadKitCatalog()]);
	const workspace = resolveWorkspaceKit(config, target.workspaceId, catalog);
	if (!kitName || kitName === workspace.kitName) {
		return { config, kit: workspace.kit, kitName: workspace.kitName, issues: workspace.issues };
	}
	const resolved = resolveKitByName(catalog, kitName, workspace.overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return { config, kit: resolved.kit, kitName, issues: [] as string[] };
}

function findCard(
	board: Awaited<ReturnType<typeof loadWorkspaceBoardById>>,
	taskId: string,
): { card: RuntimeBoardCard; column: RuntimeBoardColumnId } | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId || candidate.id.startsWith(taskId));
		if (card) {
			return { card, column: column.id };
		}
	}
	return null;
}

interface CreateOptions {
	project?: string;
	title?: string;
	prompt?: string;
	from?: string;
	model?: string[];
	tier?: string;
	agent?: string;
	base?: string;
	benchOnly?: boolean;
	start?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

async function readPrompt(
	options: CreateOptions,
	board: Awaited<ReturnType<typeof loadWorkspaceBoardById>> | null,
): Promise<{ title: string | null; prompt: string; baseRef: string | null; source: string }> {
	if (options.from) {
		const found = board ? findCard(board, options.from) : null;
		if (!found) {
			throw new Error(`--from ${options.from}: no such card on the board`);
		}
		return {
			title: found.card.title ?? null,
			prompt: found.card.prompt,
			baseRef: found.card.baseRef,
			source: `card ${found.card.id}`,
		};
	}
	if (!options.prompt) {
		throw new Error("pass --prompt <text|@file> or --from <task id>");
	}
	if (options.prompt.startsWith("@")) {
		const path = options.prompt.slice(1);
		return { title: null, prompt: await readFile(path, "utf8"), baseRef: null, source: path };
	}
	return { title: null, prompt: options.prompt, baseRef: null, source: "inline" };
}

async function runCreate(name: string, options: CreateOptions): Promise<number> {
	const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
	if (!target.repoPath) {
		throw new Error(`workspace ${target.workspaceId} has no registered repo`);
	}
	const { config, kit, kitName } = await resolveKit(target, undefined);
	if (!(kit.features ?? []).includes("runoffs")) {
		throw new Error(
			`workspace ${target.workspaceId} runs kit "${kitName}", which doesn't list the "runoffs" feature: nothing would hold the cards' PASSes, so each would land on its own`,
		);
	}
	const settings = getWorkspacePipelineSettings(config, target.workspaceId);
	const runtimeConfig = await loadGlobalRuntimeConfig();
	const defaultAgent: RuntimeAgentId =
		(options.agent as RuntimeAgentId | undefined) ??
		resolveKitRole(kit, "dev")?.agentId ??
		runtimeConfig.selectedAgentId;
	const contenders: RunoffContender[] = [
		...(options.tier ? getTierContenders(kit, options.tier, defaultAgent) : []),
		...(options.model ?? []).map((spec) => parseRunoffModelSpec(spec, defaultAgent)),
	];
	const board = await loadWorkspaceBoardById(target.workspaceId).catch(() => null);
	const source = await readPrompt(options, board);
	const baseRef = options.base ?? source.baseRef ?? settings.defaultBaseRef;
	if (!baseRef) {
		throw new Error(`no base: pass --base <ref> or set workspaces.${target.workspaceId}.defaultBaseRef`);
	}
	const title = options.title ?? source.title ?? name;
	const runoffsPath = getWatchdogWorkspacePaths(target.workspaceId).runoffs;
	const { runoffs } = await readRunoffs(runoffsPath);
	const planned = planRunoffCards({
		name,
		title,
		prompt: source.prompt,
		baseRef,
		contenders,
		resolveProvider: (contender) => resolveProposalProvider(contender.agentId, contender, config.models),
		existing: runoffs,
	});
	// Every racer is a dev-work route: an agent session may race only combinations the vetted model registry allows;
	// the user's own runoff gets a warning (src/kits/card-routing-check.ts).
	const routingWarnings = planned.flatMap((card) => {
		const check = decideCardRouting({
			config,
			kitName,
			workspaceId: target.workspaceId,
			role: "dev",
			agentId: card.agentId,
			agentSettings: card.agentSettings,
			selectedAgentId: runtimeConfig.selectedAgentId,
			fromAgentSession: readSessionCredential(process.env) !== null,
		});
		if (check.kind === "refuse") {
			throw new Error(check.message);
		}
		return check.kind === "warn" ? [check.message] : [];
	});
	const warnings = [
		...routingWarnings,
		...(settings.landing.mode === "qa"
			? []
			: [
					`workspace ${target.workspaceId} has landing mode ${settings.landing.mode}: the pipeline only QAs, holds and decides runoffs with landing qa`,
				]),
	];
	if (options.dryRun) {
		const payload = { ok: true, dryRun: true, name, runoffsPath, cards: planned, warnings };
		if (options.json) {
			printJson(payload);
		} else {
			process.stdout.write(
				`[dry-run] runoff ${name} on ${baseRef}${options.benchOnly ? " (bench only)" : ""}:\n${planned.map((card) => `  ${card.agentId} ${card.agentSettings.providerId ?? "-"}/${card.agentSettings.modelId}: ${card.title}`).join("\n")}\n`,
			);
			for (const warning of warnings) {
				process.stderr.write(`warning: ${warning}\n`);
			}
		}
		return 0;
	}
	// The group is recorded before any card exists: a card's PASS is held only while its runoff is recorded, so a
	// card created first could land on its own.
	const known = new Set(board?.columns.flatMap((column) => column.cards.map((card) => card.id)) ?? []);
	const plannedCards = planned.map((card) => {
		const taskId = createUniqueTaskId(known, randomUUID);
		known.add(taskId);
		return { taskId, card };
	});
	const createdAt = new Date().toISOString();
	const entryFor = (cards: typeof plannedCards) =>
		buildRunoffEntry({
			name,
			created: cards,
			baseRef,
			promptSource: source.source,
			benchOnly: options.benchOnly === true,
			createdAt,
		});
	await updateRunoffs(runoffsPath, (current) => {
		if (current.some((runoff) => runoff.name === name)) {
			throw new Error(`runoffs.json already has a runoff named "${name}"`);
		}
		current.push(entryFor(plannedCards));
	});
	const created: typeof plannedCards = [];
	const failures: string[] = [];
	for (const item of plannedCards) {
		try {
			await createTask({
				cwd: target.repoPath,
				projectPath: target.repoPath,
				taskId: item.taskId,
				title: item.card.title,
				prompt: item.card.prompt,
				baseRef: item.card.baseRef,
				role: "dev",
				agentId: item.card.agentId,
				agentSettings: item.card.agentSettings,
				autoReviewEnabled: false,
			});
			created.push(item);
		} catch (error) {
			failures.push(`${item.card.agentSettings.modelId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const entry = entryFor(created);
	if (failures.length > 0) {
		// Only the cards that exist race; with fewer than two there is no runoff.
		await updateRunoffs(runoffsPath, (current) => {
			const index = current.findIndex((runoff) => runoff.name === name);
			if (index >= 0) {
				current[index] =
					created.length < 2 ? { ...entry, abandoned: `cards not created: ${failures.join("; ")}` } : entry;
			}
		});
		if (created.length < 2) {
			throw new Error(
				`runoff ${name} abandoned: ${failures.join("; ")}${created.length > 0 ? ` (created ${created.map((item) => item.taskId).join(", ")}; they are ordinary cards now)` : ""}`,
			);
		}
		for (const failure of failures) {
			process.stderr.write(`warning: card not created: ${failure}\n`);
		}
	}
	const started: string[] = [];
	if (options.start) {
		for (const { taskId } of created) {
			try {
				await startTask({ cwd: target.repoPath, projectPath: target.repoPath, taskId });
				started.push(taskId);
			} catch (error) {
				// Still in the runoff: it holds the others until it is started (kanban task start) or discarded.
				process.stderr.write(
					`warning: ${taskId} was created but not started (${error instanceof Error ? error.message : String(error)}); start it with kanban task start --task-id ${taskId}, or the runoff waits for it\n`,
				);
			}
		}
	}
	if (options.json) {
		printJson({ ok: true, runoff: entry, runoffsPath, started, warnings });
		return 0;
	}
	process.stdout.write(
		`runoff ${name}: ${created.map(({ taskId, card }) => `${taskId} (${card.agentId} ${card.agentSettings.modelId})`).join(", ")} on ${baseRef}${entry.benchOnly ? ", bench only" : ""} -> ${runoffsPath}\n${options.start ? `started ${started.join(", ")}\n` : `start them with kanban task start --task-id <id> (or pass --start)\n`}`,
	);
	for (const warning of warnings) {
		process.stderr.write(`warning: ${warning}\n`);
	}
	return 0;
}

interface StatusOptions {
	project?: string;
	all?: boolean;
	json?: boolean;
}

async function runStatus(name: string | undefined, options: StatusOptions): Promise<number> {
	const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: true });
	const runoffsPath = getWatchdogWorkspacePaths(target.workspaceId).runoffs;
	const { runoffs, issues } = await readRunoffs(runoffsPath);
	const selected = runoffs.filter((runoff) =>
		name ? runoff.name === name : options.all === true || isOpenRunoff(runoff),
	);
	if (name && selected.length === 0) {
		throw new Error(`no runoff named "${name}" in ${runoffsPath}`);
	}
	const board = await loadWorkspaceBoardById(target.workspaceId).catch(() => null);
	const state = await createPipelineStateStore().peek(target.workspaceId);
	const describe = (runoff: RunoffEntry) => ({
		name: runoff.name,
		open: isOpenRunoff(runoff),
		benchOnly: runoff.benchOnly === true,
		decided: runoff.decided ?? null,
		winner: runoff.winner ?? null,
		cards: runoff.cards.map((taskId) => {
			const found = board ? findCard(board, taskId) : null;
			const hold = readPipelineHold(state?.cards[taskId]);
			return {
				taskId,
				model: runoff.models?.[taskId] ?? null,
				column: found?.column ?? null,
				held: hold?.group === runoff.name ? { round: hold.round, at: hold.at } : null,
				result: runoff.results?.find((result) => result.id === taskId) ?? null,
			};
		}),
	});
	const report = selected.map(describe);
	if (options.json) {
		printJson({ ok: true, runoffsPath, runoffs: report, issues });
		return 0;
	}
	const lines: string[] = [];
	if (report.length === 0) {
		lines.push(`No ${options.all ? "" : "open "}runoffs in ${runoffsPath}.`);
	}
	for (const runoff of report) {
		lines.push(
			`${runoff.name}: ${runoff.open ? "open" : `decided ${runoff.decided}, winner ${runoff.winner ?? "none"}`}${runoff.benchOnly ? " (bench only)" : ""}`,
		);
		for (const card of runoff.cards) {
			const state = card.result
				? `${card.result.out}${card.result.score !== undefined ? ` score ${card.result.score}` : ""}`
				: card.held
					? `PASS r${card.held.round} held`
					: (card.column ?? "not on the board");
			lines.push(`  ${card.taskId} ${card.model ?? "?"}: ${card.column ?? "gone"}, ${state}`);
		}
	}
	for (const issue of issues) {
		lines.push(`issue: ${issue}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

interface TiersOptions {
	project?: string;
	kit?: string;
	json?: boolean;
}

async function runTiers(options: TiersOptions): Promise<number> {
	let kit: KitDocument;
	let issues: string[] = [];
	if (options.project === undefined && options.kit) {
		const resolved = resolveKitByName(await loadKitCatalog(), options.kit);
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		kit = resolved.kit;
	} else {
		const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: true });
		({ kit, issues } = await resolveKit(target, options.kit));
	}
	const report = buildTiersReport(kit);
	if (options.json) {
		printJson({ ok: true, ...report, issues });
		return 0;
	}
	process.stdout.write(`${[...formatTiersReport(report), ...issues.map((issue) => `issue: ${issue}`)].join("\n")}\n`);
	return 0;
}

export function registerBenchRunoffCommands(
	bench: Command,
	runAction: <Args extends unknown[]>(
		label: string,
		run: (...args: Args) => Promise<number>,
	) => (...args: Args) => Promise<void>,
): void {
	const runoff = bench
		.command("runoff")
		.description(
			"Race several models on the same task: only the best QA PASS lands (the team kit's runoffs feature).",
		);
	runoff
		.command("create")
		.description(
			"Create one dev card per model (same prompt and base) and record the runoff in data/<ws>/runoffs.json.",
		)
		.argument("<name>", "Runoff name (letters, digits, '.', '_', '-').")
		.option(
			"--project <workspace>",
			"Workspace id or project path (default: the project containing the current directory).",
		)
		.option("--prompt <text>", "The task prompt; @file reads a file.")
		.option("--from <taskId>", "Copy the prompt, title and base of an existing card.")
		.option("--title <title>", "Card title (each card gets ' [runoff <name>: <model>]').")
		.option("--model <spec>", "[agent:][provider/]model; repeat for each contender.", collect)
		.option("--tier <tier>", "Every usable model of this kit tier (dropped models skipped).")
		.option("--agent <agentId>", "Agent for --tier and for --model specs without one (default: the kit's dev agent).")
		.option("--base <ref>", "Base branch or tag (default: --from's base, else workspaces.<id>.defaultBaseRef).")
		.option("--bench-only", "A re-run on a base that already has the work: nothing lands, every PASS is preserved.")
		.option("--start", "Start the cards after creating them.")
		.option("--dry-run", "Print the cards instead of creating them.")
		.option("--json", "Print as JSON.")
		.action(runAction("runoff create", runCreate));
	runoff
		.command("status")
		.description("Show open runoffs (or one by name): each card's column, held PASS and result.")
		.argument("[name]", "Runoff name.")
		.option("--project <workspace>", "Workspace id or project path.")
		.option("--all", "Include decided and abandoned runoffs.")
		.option("--json", "Print as JSON.")
		.action(runAction("runoff status", runStatus));
	bench
		.command("tiers")
		.description("Show the kit's model tiers, dropped models, and what the tier lookup picks.")
		.option("--project <workspace>", "Workspace id or project path (its resolved kit with overrides).")
		.option("--kit <name>", "Another kit (with the workspace's overrides when --project is given).")
		.option("--json", "Print as JSON.")
		.action(runAction("tiers", runTiers));
}
