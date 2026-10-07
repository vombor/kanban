// The team kit's `scoreboard` feature: one scoreboard line per pipeline event of a workspace whose kit lists it.
//   verdictRecorded           → a QA line (verdict, scores, blocking, visual from the QA outbox), source "qa"
//   escalated                 → an ESCALATED outcome line, source "pipeline"
//   landed via "approved"     → a HUMAN_APPROVED outcome line in the next round (Approve & land skipped QA)
// Each line carries the dev card's metrics (card-metrics.ts), and scoreboard.md is rebuilt after it. The core emits
// events only for dev cards and never for a shadow workspace, so this feature writes nothing on a shadow or `default`
// board. Agent/model on the line come from the card's session files; the event's effective agent is the fallback.
//
// Ported from archive/devteam-kit:bench/record-verdict.cjs@5266ea62 and the record-verdict calls in
// services/kanban-autoland.mjs@6da71597 (qa-ingest, recordOutcome) and bin/approve-card.mjs@6da71597 (nextRound).
import { type ParsedPipelineConfig, readPipelineConfig } from "../../../config/pipeline-config";
import type { PipelineFeature, PipelineFeatureContext } from "../../../pipeline/features";
import { getTeamBenchWorkspacePaths } from "../../../state/kanban-home";
import { normalizeScores, normalizeVisual, readScoreboard, type ScoreboardLineInput } from "./scoreboard-line";
import {
	getScoreboardName,
	type MeasureCardInput,
	type MeasuredCard,
	measureCard,
	recordScoreboardLine,
} from "./scoreboard-store";

export interface ScoreboardFeatureDependencies {
	readConfig?: () => Promise<ParsedPipelineConfig>;
	measure?: (input: MeasureCardInput) => Promise<MeasuredCard>;
	/** The workspace's data dir for its scoreboard files (tests point it at a temp dir). */
	paths?: (workspaceId: string) => ReturnType<typeof getTeamBenchWorkspacePaths>;
}

async function highestRound(path: string, taskId: string): Promise<number> {
	const { rows } = await readScoreboard(path);
	return rows.filter((row) => row.devId === taskId).reduce((max, row) => Math.max(max, row.round), 0);
}

export function createScoreboardFeature(deps: ScoreboardFeatureDependencies = {}): PipelineFeature {
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	const measure = deps.measure ?? measureCard;
	const pathsFor = deps.paths ?? ((workspaceId: string) => getTeamBenchWorkspacePaths(workspaceId));

	const record = async (context: PipelineFeatureContext, taskId: string, line: ScoreboardLineInput): Promise<void> => {
		const { config } = await readConfig();
		const measured = await measure({
			taskId,
			workspaceId: context.workspaceId,
			config,
			selectedAgentId: line.agent ?? null,
		});
		const recorded = await recordScoreboardLine({
			workspaceId: context.workspaceId,
			line,
			metrics: measured.metrics,
			name: getScoreboardName(config, context.workspaceId, measured.repoPath),
			paths: pathsFor(context.workspaceId),
		});
		context.log(
			`${taskId} r${recorded.round} ${recorded.verdict ?? "ungraded"} (${recorded.provider ?? "?"}/${recorded.model ?? "?"}, ${recorded.modelSource}) recorded`,
		);
	};

	return {
		name: "scoreboard",
		activate: (context) => {
			context.on("verdictRecorded", async (event) => {
				const report = event.report ?? {};
				let scores: ScoreboardLineInput["scores"] = null;
				let visual: ScoreboardLineInput["visual"] = null;
				try {
					scores = normalizeScores(report.scores);
				} catch (error) {
					context.log(
						`${event.taskId}: scores ignored (${error instanceof Error ? error.message : String(error)})`,
					);
				}
				try {
					visual = normalizeVisual(report.visual);
				} catch {
					visual = normalizeVisual(undefined);
				}
				await record(context, event.taskId, {
					at: new Date(event.at),
					round: event.verdict.round,
					verdict: event.verdict.verdict,
					source: "qa",
					scores,
					blocking: event.verdict.blocking ?? [],
					visual,
					benchmark: report.benchmark ?? null,
					notes: event.verdict.notes ?? "",
					agent: event.devAgentId,
				});
			});
			context.on("escalated", async (event) => {
				const round =
					event.round ??
					Math.max(1, await highestRound(pathsFor(context.workspaceId).scoreboardJsonl, event.taskId));
				await record(context, event.taskId, {
					at: new Date(event.at),
					round,
					verdict: "ESCALATED",
					source: "pipeline",
					notes: event.reason,
					agent: null,
				});
			});
			context.on("landed", async (event) => {
				if (event.via !== "approved") {
					return;
				}
				const round = (await highestRound(pathsFor(context.workspaceId).scoreboardJsonl, event.taskId)) + 1;
				await record(context, event.taskId, {
					at: new Date(event.at),
					round,
					verdict: "HUMAN_APPROVED",
					source: "pipeline",
					notes: "Approve & land without waiting for QA",
					agent: null,
				});
			});
			return undefined;
		},
	};
}
