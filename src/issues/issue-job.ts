// The issue import as a periodic job of the pipeline worker: the watchdog's job runner runs it every
// `issues.pollMin` for each workspace whose `issues.mode` is not off (a core job, not a kit feature: issue import is
// per-project config, not routing). The job fetches in the worker and asks the server to write the board with the
// `applyIssues` request, so the server stays the only board writer.
import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import type { PipelineActionRequest, PipelineActionResult } from "../pipeline/actions";
import type { PipelineWorkspaceSnapshot } from "../pipeline/engine";
import type { PipelineFeatureJob } from "../pipeline/features";
import { getIssueWorkspacePaths } from "../state/kanban-home";
import { takeIssueWakeNotes } from "./issue-state";
import { type IssueSyncDependencies, runIssueSync } from "./issue-sync";

export const ISSUE_SYNC_JOB_NAME = "issues:sync";

export interface IssueSyncJobDependencies {
	request: (request: PipelineActionRequest) => Promise<PipelineActionResult>;
	sync?: IssueSyncDependencies;
}

export interface CoreJobInput {
	workspaceId: string;
	/** The newest snapshot of the workspace (its board is what report mode plans against). */
	getSnapshot: () => PipelineWorkspaceSnapshot;
	config: PipelineConfig;
}

export function createIssueSyncJobs(deps: IssueSyncJobDependencies): (input: CoreJobInput) => PipelineFeatureJob[] {
	return (input) => {
		const settings = getWorkspacePipelineSettings(input.config, input.workspaceId).issues;
		if (settings.mode === "off") {
			return [];
		}
		const mode = settings.mode;
		return [
			{
				name: ISSUE_SYNC_JOB_NAME,
				everyMin: settings.pollMin,
				run: async () => {
					const snapshot = input.getSnapshot();
					const outcome = await runIssueSync(
						{
							workspaceId: input.workspaceId,
							workspacePath: snapshot.workspacePath,
							mode,
							readBoard: async () => input.getSnapshot().board,
							apply: async (applyInput) => {
								const { workspaceId: _workspaceId, workspacePath: _workspacePath, ...issues } = applyInput;
								const result = await deps.request({
									kind: "applyIssues",
									workspaceId: input.workspaceId,
									workspacePath: snapshot.workspacePath,
									issues,
								});
								if (!result.ok) {
									throw new Error(result.error);
								}
								if (!result.issues) {
									throw new Error("the server answered applyIssues without a result");
								}
								return result.issues;
							},
						},
						deps.sync,
					);
					if (!outcome.ok) {
						throw new Error(outcome.error ?? outcome.summary);
					}
					return `${outcome.repo}: ${outcome.summary}`;
				},
			},
		];
	};
}

/** The wake notes of started cards' issue updates, for the watchdog's next wake of the workspace's orchestrator. */
export async function takeWorkspaceIssueWakeNotes(workspaceId: string): Promise<string[]> {
	return await takeIssueWakeNotes(getIssueWorkspacePaths(workspaceId).state);
}
