// `kanban bench metrics|record-verdict|scoreboard|reset|calibrate` (and `runoff create|status`, `tiers` in bench-runoff.ts): the team kit's scoring tools for humans and backfills (plan
// §2.4). The pipeline records verdicts itself through the `scoreboard` feature; these commands write the same files
// (`<home>/data/<workspace>/scoreboard.jsonl`, `scoreboard.md`), whatever the workspace's kit.
//
// Ported from archive/devteam-kit:bench/card-metrics.cjs@760fd36c, bench/record-verdict.cjs@5266ea62,
// bench/scoreboard.cjs@d2fb30fc and bench/snapshot-reset.mjs@264680fc; `calibrate` is bench-calibrate.ts.
import { readFile } from "node:fs/promises";
import { type Command, Option } from "commander";

import { getWorkspacePipelineSettings, type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import { resetBench } from "../kits/team/bench/bench-reset";
import { locateCard } from "../kits/team/bench/card-locator";
import {
	buildScoreboardLine,
	isOutcomeVerdict,
	isQaVerdict,
	normalizeScores,
	normalizeVisual,
	type ScoreboardLineInput,
} from "../kits/team/scoreboard/scoreboard-line";
import {
	getScoreboardName,
	getUnscoredCardRole,
	measureCard,
	rebuildScoreboardMarkdown,
	recordScoreboardLine,
} from "../kits/team/scoreboard/scoreboard-store";
import { getPipelineStatePath, getPricesDataPaths, getTeamBenchWorkspacePaths } from "../state/kanban-home";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { type CalibrateOptions, runCalibrateCommand } from "./bench-calibrate";
import { registerBenchRunoffCommands } from "./bench-runoff";
import { resolveWorkspaceTarget, type WorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readConfig(): Promise<PipelineConfig> {
	const { config, issues } = await readPipelineConfig();
	for (const issue of issues.filter((entry) => entry.startsWith("agents") || entry.startsWith("workspaces"))) {
		process.stderr.write(`config.json: ${issue}\n`);
	}
	return config;
}

async function readSelectedAgentId() {
	return (await loadGlobalRuntimeConfig()).selectedAgentId;
}

/** A JSON option value, or `@/path/file.json` (avoids shell quoting). */
async function parseJsonOption(name: string, value: string | undefined, fallback: unknown): Promise<unknown> {
	if (value === undefined) {
		return fallback;
	}
	const text = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${name} is not valid JSON: ${toErrorMessage(error)}`);
	}
}

interface MetricsOptions {
	at?: string;
	project?: string;
}

async function runMetrics(taskId: string, options: MetricsOptions): Promise<number> {
	const config = await readConfig();
	const target = options.project ? await resolveWorkspaceTarget(options.project, { allowUnregistered: false }) : null;
	const { metrics } = await measureCard({
		taskId,
		workspaceId: target?.workspaceId ?? null,
		at: options.at ?? null,
		selectedAgentId: await readSelectedAgentId(),
		config,
	});
	printJson(metrics);
	return 0;
}

interface RecordVerdictOptions {
	dev?: string;
	round: string;
	verdict?: string;
	source: string;
	scores?: string;
	blocking?: string;
	visual?: string;
	notes?: string;
	benchmark?: string;
	ts?: string;
	at?: string;
	board: boolean;
	dryRun?: boolean;
	force?: boolean;
	project?: string;
}

async function runRecordVerdict(devArgument: string | undefined, options: RecordVerdictOptions): Promise<number> {
	const taskId = options.dev ?? devArgument;
	if (!taskId) {
		throw new Error("--dev <task id> is required");
	}
	const source = options.source;
	if (source !== "qa" && source !== "pipeline") {
		throw new Error('--source must be "qa" or "pipeline"');
	}
	const verdict = options.verdict === undefined || options.verdict === "null" ? null : options.verdict;
	const verdictOk = source === "qa" ? verdict === null || isQaVerdict(verdict) : isOutcomeVerdict(verdict);
	if (!verdictOk) {
		throw new Error(
			source === "qa"
				? "--verdict must be PASS|FAIL|STALLED|DNF (or null) for --source qa"
				: "--verdict must be CONFLICT|ESCALATED|AGENT_ERROR|HUMAN_APPROVED for --source pipeline",
		);
	}
	const round = Number(options.round);
	const blocking = await parseJsonOption("--blocking", options.blocking, []);
	if (!Array.isArray(blocking)) {
		throw new Error("--blocking must be a JSON array of strings");
	}
	const scores = normalizeScores(await parseJsonOption("--scores", options.scores, null));
	const visual = normalizeVisual(await parseJsonOption("--visual", options.visual, undefined));
	const at = options.ts ? new Date(options.ts) : new Date();
	if (Number.isNaN(at.getTime())) {
		throw new Error(`--ts ${options.ts} is not a date`);
	}

	const config = await readConfig();
	const target: WorkspaceTarget | null = options.project
		? await resolveWorkspaceTarget(options.project, { allowUnregistered: false })
		: null;
	const located = await locateCard(taskId, target?.workspaceId ?? null);
	const workspaceId = located?.workspaceId ?? target?.workspaceId ?? null;
	if (!workspaceId) {
		throw new Error(`card ${taskId} is on no registered board or backup; pass --project <workspace id or path>`);
	}
	if (located) {
		const role = getUnscoredCardRole(located.boardCard);
		if (role && !options.force) {
			throw new Error(`card ${located.card.id} is a ${role} card, not a dev card (--force to record it anyway)`);
		}
	}
	const { metrics, repoPath } = await measureCard({
		taskId: located?.card.id ?? taskId,
		workspaceId,
		at: options.at ?? null,
		selectedAgentId: await readSelectedAgentId(),
		config,
	});
	const line: ScoreboardLineInput = {
		at,
		round,
		verdict: verdict as ScoreboardLineInput["verdict"],
		source,
		scores,
		blocking: blocking.map(String),
		visual,
		benchmark: options.benchmark ?? null,
		notes: options.notes ?? "",
	};
	const paths = getTeamBenchWorkspacePaths(workspaceId);
	if (options.dryRun) {
		process.stdout.write(`${JSON.stringify(buildScoreboardLine(metrics, line))}\n`);
		return 0;
	}
	const recorded = await recordScoreboardLine({
		workspaceId,
		line,
		metrics,
		name: getScoreboardName(config, workspaceId, repoPath ?? located?.repoPath ?? null),
		paths,
		skipMarkdown: !options.board,
	});
	process.stdout.write(
		`record-verdict: ${recorded.devId} r${recorded.round} ${recorded.verdict ?? "ungraded"} (${recorded.provider ?? "?"}/${recorded.model ?? "?"}, ${recorded.modelSource}) -> ${paths.scoreboardJsonl}\n`,
	);
	return 0;
}

interface ScoreboardOptions {
	project?: string;
}

async function runScoreboard(options: ScoreboardOptions): Promise<number> {
	const config = await readConfig();
	const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: true });
	const paths = getTeamBenchWorkspacePaths(target.workspaceId);
	const rows = await rebuildScoreboardMarkdown({
		paths,
		name: getScoreboardName(config, target.workspaceId, target.repoPath),
	});
	process.stdout.write(`scoreboard: ${rows} rows -> ${paths.scoreboardMd}\n`);
	return 0;
}

interface ResetOptions {
	project?: string;
	base?: string;
	force?: boolean;
	dryRun?: boolean;
}

async function runReset(label: string, options: ResetOptions): Promise<number> {
	const config = await readConfig();
	const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
	if (!target.repoPath) {
		throw new Error(`workspace ${target.workspaceId} has no registered repo`);
	}
	const settings = getWorkspacePipelineSettings(config, target.workspaceId);
	const baseRef = options.base ?? settings.defaultBaseRef;
	if (!baseRef) {
		throw new Error(`no base branch: pass --base <ref> or set workspaces.${target.workspaceId}.defaultBaseRef`);
	}
	const result = await resetBench({
		label,
		paths: getTeamBenchWorkspacePaths(target.workspaceId),
		extraFiles: [getPipelineStatePath(target.workspaceId), getPricesDataPaths().modelPricesMd],
		board: await loadWorkspaceBoardById(target.workspaceId),
		repoPath: target.repoPath,
		baseRef,
		name: getScoreboardName(config, target.workspaceId, target.repoPath),
		force: options.force,
		dryRun: options.dryRun,
	});
	process.stdout.write(
		`${result.dryRun ? "[dry-run] " : ""}snapshot ${label}: ${result.scoreboardLines} scoreboard line(s), ${result.files.length} file(s) → ${result.snapshotDir}; tag ${result.tag} on ${baseRef}\n`,
	);
	if (result.tagError) {
		process.stderr.write(`tag failed: ${result.tagError}\n`);
	}
	if (!result.dryRun) {
		process.stdout.write(`done: ${result.snapshotDir}\n`);
	}
	return 0;
}

function runAction<Args extends unknown[]>(label: string, run: (...args: Args) => Promise<number>) {
	return async (...args: Args): Promise<void> => {
		try {
			process.exitCode = await run(...args);
		} catch (error) {
			process.stderr.write(`bench ${label}: ${toErrorMessage(error)}\n`);
			process.exitCode = 2;
		}
	};
}

export function registerBenchCommand(program: Command): void {
	const bench = program
		.command("bench")
		.description(
			"The team kit's scoring tools: card metrics, the QA scoreboard, benchmark resets, QA calibrations, runoffs and model tiers.",
		);
	bench
		.command("metrics")
		.description("Print who built a card (agent/provider/model, from its session files) and what it cost, as JSON.")
		.argument("<taskId>", "Card id or id prefix (live boards first, then board backups).")
		.option("--at <iso>", "Measure up to the latest review snapshot at or before this time (backfills).")
		.option("--project <workspace>", "Only look on this workspace (id or project path).")
		.action(runAction("metrics", runMetrics));
	bench
		.command("record-verdict")
		.description(
			"Append one QA verdict or pipeline outcome line to the card's workspace scoreboard and rebuild scoreboard.md.",
		)
		.argument("[taskId]", "The dev card (same as --dev).")
		.option("--dev <taskId>", "The dev card.")
		.option("--round <n>", "QA round (a positive integer).", "1")
		.option(
			"--verdict <verdict>",
			"PASS|FAIL|STALLED|DNF (or null) for --source qa; CONFLICT|ESCALATED|AGENT_ERROR|HUMAN_APPROVED for --source pipeline.",
		)
		.option("--source <source>", "qa or pipeline.", "qa")
		.option(
			"--scores <json>",
			'Scores 0-5 or null per dimension, e.g. {"spec":4,"correctness":4,"tests":3,"ux":null,"code":4,"process":3}; @file reads a file.',
		)
		.option("--blocking <json>", "JSON array of blocking issues; @file reads a file.")
		.option("--visual <json>", '{"status":"ok|blocked|n/a","artifacts":[…],"consoleErrors":0}; @file reads a file.')
		.option("--notes <text>", "Short notes (400 characters kept).")
		.option("--benchmark <name>", "Benchmark or runoff name.")
		.option("--ts <iso>", "Timestamp of the line (default: now).")
		.option("--at <iso>", "Measure up to the latest review snapshot at or before this time (backfills).")
		.option("--no-board", "Don't rebuild scoreboard.md.")
		.option("--dry-run", "Print the line instead of writing it.")
		.option("--force", "Record it even when the card is a QA or TRIAGE card.")
		.option("--project <workspace>", "The card's workspace (id or project path) when it is on no board any more.")
		.action(runAction("record-verdict", runRecordVerdict));
	bench
		.command("scoreboard")
		.description("Rebuild a workspace's scoreboard.md from its scoreboard.jsonl.")
		.option(
			"--project <workspace>",
			"Workspace id or project path (default: the project containing the current directory).",
		)
		.action(runAction("scoreboard", runScoreboard));
	bench
		.command("reset")
		.description(
			"Archive a workspace's QA measurements under data/<ws>/bench/snapshots/<label>, tag the base bench/<label> and restart the scoreboard empty.",
		)
		.argument("<label>", "Snapshot name (letters, digits, '.', '_', '-').")
		.option(
			"--project <workspace>",
			"Workspace id or project path (default: the project containing the current directory).",
		)
		.option("--base <ref>", "Branch to tag (default: workspaces.<id>.defaultBaseRef).")
		.option("--force", "Reset even with cards In Progress or in Review.")
		.option("--dry-run", "Print what would be archived.")
		.action(runAction("reset", runReset));
	bench
		.command("calibrate")
		.description(
			"Run a QA calibration: the same QA review on fixed snapshots by several QA models (calibration cards), detached; results in data/<ws>/calibration/<name>/.",
		)
		.argument("<spec>", "The calibration spec (JSON: name, workspace, parallel, timeoutMin, sets[], models[]).")
		.option(
			"--project <workspace>",
			"Workspace id or project path (default: the spec's workspace, else the current project).",
		)
		.option("--foreground", "Run in this process instead of detaching (logs to stderr too).")
		.option("--print", "Check the inputs (dev prompts, refs) without creating cards.")
		.option("--force", "Run on a workspace whose kit doesn't list the calibration feature.")
		.addOption(new Option("--worker", "The detached runner (started by calibrate itself).").hideHelp())
		.action(runAction("calibrate", (spec: string, options: CalibrateOptions) => runCalibrateCommand(spec, options)));
	registerBenchRunoffCommands(bench, runAction);
}
