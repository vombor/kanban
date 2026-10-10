// Ends a Cline card's run in Cline's shared hub when the card's TUI is gone without the card being finished (issue
// #28): the TUI process exited (foo QA 33288: exit 0 mid-`run_commands`, its run waited on a hook for the gone TUI
// for 10 h), or it died with the previous server (restart: `markOrphanedSessionsInterrupted`). Done, task delete and
// project removal end the worktree's runs themselves (prepareTaskProcessReap), before the worktree is deleted.
//
// Only the sessions this run started are ended (from the run's `startedAt` to its exit), so a relaunch that already
// has a new session in the same worktree keeps it. Each run is ended once.
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { getAgentTurnEndSource } from "../terminal/agent-session-adapters";
import type { ClineHubRunCanceller } from "../terminal/cline-hub-runs";
import type { TerminalSessionManager } from "../terminal/session-manager";

export type ClineHubRunFollowerSessions = Pick<TerminalSessionManager, "onSummary">;

export interface ClineHubRunFollowerDependencies {
	canceller: ClineHubRunCanceller;
	log: (message: string) => void;
	now?: () => number;
}

export interface ClineHubRunFollower {
	/** Follows a workspace's session summaries; replaces an earlier subscription for the same workspace. */
	trackWorkspace: (workspaceId: string, sessions: ClineHubRunFollowerSessions) => void;
	untrackWorkspace: (workspaceId: string) => void;
	/** Ends the hub runs of sessions that died with the previous server (the summaries restart marked interrupted). */
	endOrphanedRuns: (workspaceId: string, summaries: readonly RuntimeTaskSessionSummary[]) => void;
	/** Resolves once every cancellation started so far has settled (tests, shutdown). */
	settle: () => Promise<void>;
}

interface LiveRun {
	startedAt: number | null;
	workspacePath: string;
}

function readsClineSessionFiles(summary: RuntimeTaskSessionSummary): boolean {
	return getAgentTurnEndSource(summary.agentId) === "cline-session-files";
}

export function createClineHubRunFollower(deps: ClineHubRunFollowerDependencies): ClineHubRunFollower {
	const now = deps.now ?? Date.now;
	const subscriptions = new Map<string, () => void>();
	const liveRuns = new Map<string, Map<string, LiveRun>>();
	const ended = new Set<string>();
	const inFlight = new Set<Promise<void>>();

	const endRun = (workspaceId: string, taskId: string, run: LiveRun, reason: string): void => {
		const key = `${workspaceId}\u0000${taskId}\u0000${run.workspacePath}\u0000${run.startedAt ?? ""}`;
		if (ended.has(key)) {
			return;
		}
		ended.add(key);
		const task = deps.canceller
			.cancelRuns({
				workspaceId,
				taskId,
				worktreePaths: [run.workspacePath],
				window: { from: run.startedAt, to: now() },
				reason,
			})
			.then(
				() => undefined,
				(error: unknown) => {
					deps.log(
						`Could not end the Cline hub run of ${workspaceId}/${taskId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				},
			)
			.finally(() => {
				inFlight.delete(task);
			});
		inFlight.add(task);
	};

	const onSummary = (workspaceId: string, summary: RuntimeTaskSessionSummary): void => {
		const runs = liveRuns.get(workspaceId);
		if (!runs || !readsClineSessionFiles(summary)) {
			return;
		}
		if (typeof summary.pid === "number" && summary.workspacePath) {
			runs.set(summary.taskId, { startedAt: summary.startedAt, workspacePath: summary.workspacePath });
			return;
		}
		const run = runs.get(summary.taskId);
		if (summary.pid === null && run) {
			runs.delete(summary.taskId);
			endRun(
				workspaceId,
				summary.taskId,
				run,
				`Kanban ended this run: its card's Cline TUI exited${summary.exitCode === null ? "" : ` (code ${summary.exitCode})`}`,
			);
		}
	};

	return {
		trackWorkspace: (workspaceId, sessions) => {
			subscriptions.get(workspaceId)?.();
			liveRuns.set(workspaceId, liveRuns.get(workspaceId) ?? new Map());
			subscriptions.set(
				workspaceId,
				sessions.onSummary((summary) => onSummary(workspaceId, summary)),
			);
		},
		untrackWorkspace: (workspaceId) => {
			subscriptions.get(workspaceId)?.();
			subscriptions.delete(workspaceId);
			liveRuns.delete(workspaceId);
		},
		endOrphanedRuns: (workspaceId, summaries) => {
			for (const summary of summaries) {
				if (readsClineSessionFiles(summary) && summary.workspacePath) {
					endRun(
						workspaceId,
						summary.taskId,
						{ startedAt: summary.startedAt, workspacePath: summary.workspacePath },
						"Kanban ended this run: its card's Cline TUI died with the previous Kanban server",
					);
				}
			}
		},
		settle: async () => {
			while (inFlight.size > 0) {
				await Promise.all([...inFlight]);
			}
		},
	};
}
