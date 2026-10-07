// Records scoreboard lines for a workspace and rebuilds its scoreboard.md: the one writer behind the `scoreboard`
// feature (pipeline events) and `kanban bench record-verdict` (humans, backfills).
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { PipelineConfig } from "../../../config/pipeline-config";
import type { RuntimeAgentId, RuntimeTaskRole } from "../../../core/api-contract";
import { type CardRoleInput, resolveCardRole } from "../../../core/card-role";
import {
	getClineDataDirPath,
	getCodexSessionsPath,
	getTaskWorktreeSearchRootPaths,
	getTeamBenchWorkspacePaths,
	type TeamBenchWorkspacePaths,
} from "../../../state/kanban-home";
import { getClineSessionsPath } from "../../../terminal/cline-session-files";
import { locateCard } from "../bench/card-locator";
import {
	type CardMetrics,
	type CardMetricsCard,
	type CardMetricsSources,
	computeCardMetrics,
	readReviewSnapshots,
} from "../bench/card-metrics";
import { loadPriceTable } from "../bench/prices";
import {
	appendScoreboardLine,
	buildScoreboardLine,
	readScoreboard,
	type ScoreboardLine,
	type ScoreboardLineInput,
} from "./scoreboard-line";
import { renderScoreboardMarkdown } from "./scoreboard-markdown";

// A QA or TRIAGE card is the reviewer, not the scored work. Calibration cards are scored (their QA lines carry a
// benchmark). Cards the legacy kit made have no `role`; resolveCardRole() recognises them by its exact markers.
const UNSCORED_ROLES: ReadonlySet<RuntimeTaskRole> = new Set(["qa", "triage"]);

/** The card's role when it is one the scoreboard doesn't score (qa, triage), else null. */
export function getUnscoredCardRole(card: CardRoleInput): RuntimeTaskRole | null {
	const role = resolveCardRole(card);
	return UNSCORED_ROLES.has(role) ? role : null;
}

/** Metric sources for a card in `repoPath`, from the core settings (agent data dirs) and the home. */
export async function createCardMetricsSources(
	config: PipelineConfig,
	repoPath: string | null,
): Promise<CardMetricsSources> {
	return {
		clineSessionsPath: getClineSessionsPath(getClineDataDirPath(config.agents.cline.dataDir)),
		codexSessionsPath: getCodexSessionsPath(config.agents.codex.home),
		worktreeRoots: getTaskWorktreeSearchRootPaths(),
		prices: await loadPriceTable(),
		readSnapshots: async (taskId, atMs) => (repoPath ? await readReviewSnapshots(repoPath, taskId, atMs) : []),
	};
}

export interface MeasureCardInput {
	taskId: string;
	/** Restrict the lookup to one workspace (the pipeline knows it); null searches every registered one. */
	workspaceId: string | null;
	at?: string | null;
	selectedAgentId?: RuntimeAgentId | null;
	config: PipelineConfig;
}

export interface MeasuredCard {
	metrics: CardMetrics;
	workspaceId: string | null;
	repoPath: string | null;
}

/** Locates the card (board, then backups) and computes its metrics; an unknown card is measured from session files only. */
export async function measureCard(input: MeasureCardInput): Promise<MeasuredCard> {
	const located = await locateCard(input.taskId, input.workspaceId);
	const card: CardMetricsCard | null = located?.card ?? null;
	const repoPath = located?.repoPath ?? null;
	const metrics = await computeCardMetrics(
		{ taskId: input.taskId, card, at: input.at ?? null, selectedAgentId: input.selectedAgentId ?? null },
		await createCardMetricsSources(input.config, repoPath),
	);
	return { metrics, workspaceId: located?.workspaceId ?? input.workspaceId, repoPath };
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, text);
	await rename(temporary, path);
}

/** The scoreboard title: the workspace's configured name, else its repo dir name, else its id. */
export function getScoreboardName(config: PipelineConfig, workspaceId: string, repoPath: string | null): string {
	return config.workspaces[workspaceId]?.name ?? (repoPath ? basename(repoPath) : workspaceId);
}

/** Rewrites `scoreboard.md` from `scoreboard.jsonl`. Returns the number of rows. */
export async function rebuildScoreboardMarkdown(input: {
	paths: Pick<TeamBenchWorkspacePaths, "scoreboardJsonl" | "scoreboardMd">;
	name: string;
	now?: Date;
}): Promise<number> {
	const file = await readScoreboard(input.paths.scoreboardJsonl);
	await writeFileAtomic(
		input.paths.scoreboardMd,
		renderScoreboardMarkdown({
			name: input.name,
			sourcePath: input.paths.scoreboardJsonl,
			file,
			generatedAt: input.now ?? new Date(),
		}),
	);
	return file.rows.length;
}

export interface RecordScoreboardInput {
	workspaceId: string;
	line: ScoreboardLineInput;
	metrics: CardMetrics;
	name: string;
	paths?: TeamBenchWorkspacePaths;
	/** Skip rebuilding scoreboard.md (bulk backfills rebuild once at the end). */
	skipMarkdown?: boolean;
}

/** Appends one line to the workspace's scoreboard.jsonl and rebuilds scoreboard.md next to it. */
export async function recordScoreboardLine(input: RecordScoreboardInput): Promise<ScoreboardLine> {
	const paths = input.paths ?? getTeamBenchWorkspacePaths(input.workspaceId);
	const line = buildScoreboardLine(input.metrics, input.line);
	await appendScoreboardLine(paths.scoreboardJsonl, line);
	if (!input.skipMarkdown) {
		await rebuildScoreboardMarkdown({ paths, name: input.name, now: input.line.at });
	}
	return line;
}
