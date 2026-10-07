// `kanban pipeline import-legacy` (P5-2, plan §8.4 step 2): before a workspace's shadow goes off, copy the legacy
// kit's per-project state into Kanban's, so the pipeline picks up where the legacy kit's autoland left off:
// - checks-state.json → pipeline-state.json: the entries of the cards still open (recovery, rework and the QA gate
//   read the legacy key names; the first load already imported the whole file once, so only those can be newer);
// - runoffs.json → data/<id>/runoffs.json (same format, decided groups too);
// - the scoreboard (foo's `bench/scoreboard.jsonl`) → data/<id>/scoreboard.jsonl, without duplicates;
// - qa-log.md → data/<id>/qa-log.md while Kanban has none: the QA gate numbers a card's rounds from it.
// It only reads the legacy files and is safe to run again. It refuses while the legacy autoland still owns the
// workspace (both would write the same state) and unless the workspace is on landing `qa` in shadow: after the
// switch Kanban's own state is newer than the legacy kit's, and copying would roll it back.
import { readFile } from "node:fs/promises";

import {
	getLegacyKitRunPath,
	type LegacyKitConfigFile,
	type LegacyKitProjectFiles,
	type LegacyKitService,
	legacyKitServiceOwns,
	listLegacyKitProjects,
	readLegacyKitConfig,
	readLegacyKitServices,
	resolveLegacyKitProjectFiles,
} from "../config/legacy-kit-config";
import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardData } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { importLegacyRunoffs, type RunoffsImportPlan } from "../kits/team/runoffs/runoffs-import";
import { importLegacyScoreboard, type ScoreboardImportPlan } from "../kits/team/scoreboard/scoreboard-import";
import { getScoreboardName, rebuildScoreboardMarkdown } from "../kits/team/scoreboard/scoreboard-store";
import {
	getPipelineQaLogPath,
	getPipelineStatePath,
	getTeamBenchWorkspacePaths,
	getWatchdogWorkspacePaths,
} from "../state/kanban-home";
import {
	createPipelineStateStore,
	importLegacyChecksState,
	type LegacyCardEntriesMerge,
	mergeLegacyCardEntries,
	type PipelineStateStore,
} from "./pipeline-state";

export interface LegacyImportTargets {
	pipelineState: string;
	runoffs: string;
	scoreboardJsonl: string;
	scoreboardMd: string;
	qaLog: string;
}

export interface LegacyImportDependencies {
	readConfig?: () => Promise<ParsedPipelineConfig>;
	readLegacyKit?: () => Promise<LegacyKitConfigFile>;
	readServices?: (raw: LegacyKitConfigFile["raw"]) => LegacyKitService[];
	/** The legacy kit's files for the workspace (default: from its kit.config.json). */
	legacyFiles?: (raw: NonNullable<LegacyKitConfigFile["raw"]>, workspaceId: string) => LegacyKitProjectFiles;
	targets?: (workspaceId: string) => LegacyImportTargets;
	store?: PipelineStateStore;
	loadBoard: (workspaceId: string) => Promise<RuntimeBoardData>;
	now?: () => Date;
}

export interface LegacyImportInput {
	workspaceId: string;
	repoPath: string | null;
	dryRun: boolean;
	/** Dry run only: plan even while a guard would refuse. */
	force: boolean;
}

export type QaLogImportAction = "copied" | "already-there" | "kept-different" | "no-legacy-log";

export interface LegacyImportReport {
	workspaceId: string;
	dryRun: boolean;
	/** Guards that refuse the import (with --force on a dry run: what the real run would refuse). */
	refusals: string[];
	from: LegacyKitProjectFiles;
	to: LegacyImportTargets;
	pipelineState: (Omit<LegacyCardEntriesMerge, "state"> & { created: boolean }) | null;
	runoffs: RunoffsImportPlan | null;
	scoreboard: ScoreboardImportPlan | null;
	qaLog: QaLogImportAction | null;
	/** Items left out, with the reason (a file that is both source and target, a file that can't be read). */
	skipped: string[];
}

function defaultTargets(workspaceId: string): LegacyImportTargets {
	const bench = getTeamBenchWorkspacePaths(workspaceId);
	return {
		pipelineState: getPipelineStatePath(workspaceId),
		runoffs: getWatchdogWorkspacePaths(workspaceId).runoffs,
		scoreboardJsonl: bench.scoreboardJsonl,
		scoreboardMd: bench.scoreboardMd,
		qaLog: getPipelineQaLogPath(workspaceId),
	};
}

async function readTextOrNull(path: string): Promise<string | null> {
	return await readFile(path, "utf8").catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	});
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function openTaskIdsOf(board: RuntimeBoardData): Set<string> {
	return new Set(
		board.columns.filter((column) => column.id !== "trash").flatMap((column) => column.cards.map((card) => card.id)),
	);
}

function findRefusals(input: {
	workspaceId: string;
	config: ParsedPipelineConfig;
	legacy: NonNullable<LegacyKitConfigFile["raw"]>;
	services: LegacyKitService[];
}): string[] {
	const refusals: string[] = [];
	const settings = getWorkspacePipelineSettings(input.config.config, input.workspaceId);
	if (settings.landing.mode !== "qa" || !settings.pipeline.shadow) {
		refusals.push(
			`${input.workspaceId} is on landing ${settings.landing.mode}${settings.pipeline.shadow ? " (shadow)" : ""}, not landing qa in shadow: import before turning shadow off (after the switch Kanban's state is newer than the legacy kit's)`,
		);
	}
	const listed = listLegacyKitProjects(input.legacy).some((project) => project.workspaceId === input.workspaceId);
	const autoland = input.services.find((service) => service.name === "autoland");
	if (listed && legacyKitServiceOwns(autoland, true)) {
		const runPath = getLegacyKitRunPath(input.legacy);
		refusals.push(
			`the legacy kit's autoland still owns ${input.workspaceId} (${autoland?.pid !== null && autoland?.pid !== undefined ? `running, pid ${autoland.pid}` : "not disabled, review-watch would restart it"}): touch ${runPath}/autoland.disabled && kit stop autoland`,
		);
	}
	return refusals;
}

export async function runLegacyImport(
	input: LegacyImportInput,
	deps: LegacyImportDependencies,
): Promise<LegacyImportReport> {
	if (input.force && !input.dryRun) {
		throw new Error("--force only works with --dry-run");
	}
	const legacyKit = await (deps.readLegacyKit ?? (async () => await readLegacyKitConfig()))();
	if (!legacyKit.raw) {
		throw new Error(
			`no legacy kit config to import from (${legacyKit.path}${legacyKit.error ? `: ${legacyKit.error}` : " absent"})`,
		);
	}
	const config = await (deps.readConfig ?? (async () => await readPipelineConfig()))();
	const services = (deps.readServices ?? ((raw) => readLegacyKitServices(raw)))(legacyKit.raw);
	const from = (deps.legacyFiles ?? resolveLegacyKitProjectFiles)(legacyKit.raw, input.workspaceId);
	const to = (deps.targets ?? defaultTargets)(input.workspaceId);
	const report: LegacyImportReport = {
		workspaceId: input.workspaceId,
		dryRun: input.dryRun,
		refusals: findRefusals({ workspaceId: input.workspaceId, config, legacy: legacyKit.raw, services }),
		from,
		to,
		pipelineState: null,
		runoffs: null,
		scoreboard: null,
		qaLog: null,
		skipped: [],
	};
	if (report.refusals.length > 0 && !input.force) {
		return report;
	}
	const dryRun = input.dryRun;
	const sameFile = (label: string, source: string, target: string): boolean => {
		if (source === target) {
			report.skipped.push(`${label}: ${source} is already Kanban's file`);
			return true;
		}
		return false;
	};
	const attempt = async (label: string, run: () => Promise<void>): Promise<void> => {
		try {
			await run();
		} catch (error) {
			report.skipped.push(`${label}: ${toErrorMessage(error)}`);
		}
	};

	await attempt("pipeline-state", async () => {
		const legacyText = await readTextOrNull(from.state);
		if (legacyText === null) {
			report.skipped.push(`pipeline-state: no ${from.state}`);
			return;
		}
		const legacy = importLegacyChecksState(JSON.parse(legacyText), from.state, new Date(0).toISOString());
		if (!legacy) {
			report.skipped.push(`pipeline-state: ${from.state} is not a JSON object`);
			return;
		}
		const openTaskIds = openTaskIdsOf(await deps.loadBoard(input.workspaceId));
		const store =
			deps.store ??
			createPipelineStateStore({
				getStatePath: () => to.pipelineState,
				getLegacyChecksStatePaths: () => [from.state],
			});
		const current = await store.peek(input.workspaceId);
		// Without a pipeline-state.json the store's first load imports the whole checks-state.json; the merge then
		// finds every open card's entry already there.
		const merged: { value?: LegacyCardEntriesMerge } = {};
		if (dryRun) {
			merged.value = mergeLegacyCardEntries(current ?? legacy, legacy.cards, openTaskIds);
		} else {
			await store.update(input.workspaceId, (state) => {
				merged.value = mergeLegacyCardEntries(state, legacy.cards, openTaskIds);
				return merged.value.state;
			});
		}
		if (merged.value) {
			const { state: _state, ...merge } = merged.value;
			report.pipelineState = { ...merge, created: current === null };
		}
	});

	await attempt("runoffs", async () => {
		if (!sameFile("runoffs", from.runoffs, to.runoffs)) {
			report.runoffs = await importLegacyRunoffs({ from: from.runoffs, to: to.runoffs, dryRun });
		}
	});

	await attempt("scoreboard", async () => {
		if (sameFile("scoreboard", from.scoreboard, to.scoreboardJsonl)) {
			return;
		}
		report.scoreboard = await importLegacyScoreboard({ from: from.scoreboard, to: to.scoreboardJsonl, dryRun });
		if (!dryRun && report.scoreboard.added.length > 0) {
			await rebuildScoreboardMarkdown({
				paths: { scoreboardJsonl: to.scoreboardJsonl, scoreboardMd: to.scoreboardMd },
				name: getScoreboardName(config.config, input.workspaceId, input.repoPath),
				now: deps.now?.(),
			});
		}
	});

	await attempt("qa-log", async () => {
		if (sameFile("qa-log", from.qaLog, to.qaLog)) {
			return;
		}
		const legacyLog = await readTextOrNull(from.qaLog);
		if (!legacyLog?.trim()) {
			report.qaLog = "no-legacy-log";
			return;
		}
		const current = (await readTextOrNull(to.qaLog)) ?? "";
		if (current.startsWith(legacyLog)) {
			report.qaLog = "already-there";
		} else if (current.trim()) {
			// Kanban already wrote its own QA log: never mix the two by guesswork.
			report.qaLog = "kept-different";
		} else {
			report.qaLog = "copied";
			if (!dryRun) {
				await lockedFileSystem.writeTextFileAtomic(to.qaLog, legacyLog);
			}
		}
	});
	return report;
}

/** The report as lines for a person: what was (or would be) copied from where to where. */
export function formatLegacyImportReport(report: LegacyImportReport): string[] {
	const verb = report.dryRun ? "would copy" : "copied";
	const lines: string[] = [
		`${report.dryRun ? "Dry run: " : ""}import of the legacy kit's state for ${report.workspaceId}`,
	];
	for (const refusal of report.refusals) {
		lines.push(`${report.dryRun ? "would refuse" : "refused"}: ${refusal}`);
	}
	const state = report.pipelineState;
	if (state) {
		lines.push(
			`pipeline-state: ${report.from.state} → ${report.to.pipelineState}${state.created ? " (new file: the whole checks-state.json is imported first)" : ""}`,
		);
		for (const change of state.changes) {
			lines.push(
				`  ${verb} ${change.taskId} (${change.action}${change.keys.length > 0 ? `: ${change.keys.join(", ")}` : ""})`,
			);
		}
		lines.push(
			`  ${state.unchanged.length} open card(s) already up to date, ${state.skipped.length} entr${state.skipped.length === 1 ? "y" : "ies"} of Done/trashed/deleted cards left as they are`,
		);
	}
	const runoffs = report.runoffs;
	if (runoffs) {
		lines.push(`runoffs: ${report.from.runoffs} → ${report.to.runoffs}`);
		for (const name of runoffs.added) {
			lines.push(`  ${verb} ${name} (new${runoffs.open.includes(name) ? ", open" : ", decided"})`);
		}
		for (const name of runoffs.replaced) {
			lines.push(`  ${verb} ${name} (replaces Kanban's entry${runoffs.open.includes(name) ? ", open" : ""})`);
		}
		lines.push(`  ${runoffs.unchanged.length} group(s) already up to date`);
		for (const issue of runoffs.issues) {
			lines.push(`  not copied: ${issue}`);
		}
	}
	const scoreboard = report.scoreboard;
	if (scoreboard) {
		lines.push(
			`scoreboard: ${report.from.scoreboard} → ${report.to.scoreboardJsonl}: ${verb} ${scoreboard.added.length} line(s), ${scoreboard.alreadyThere} already there${scoreboard.badLegacyLines.length > 0 ? `, ${scoreboard.badLegacyLines.length} unreadable (lines ${scoreboard.badLegacyLines.join(", ")})` : ""}`,
		);
	}
	if (report.qaLog) {
		const qaLogText: Record<QaLogImportAction, string> = {
			copied: verb,
			"already-there": "already there",
			"kept-different": "not copied: Kanban's QA log already has other content (merge by hand)",
			"no-legacy-log": "no legacy QA log",
		};
		lines.push(`qa-log: ${report.from.qaLog} → ${report.to.qaLog}: ${qaLogText[report.qaLog]}`);
	}
	for (const skipped of report.skipped) {
		lines.push(`skipped ${skipped}`);
	}
	return lines;
}
