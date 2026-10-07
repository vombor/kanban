// The server writes session summaries to sessions.json itself, so restart recovery and `kanban restart prepare` read
// real summaries with no browser open. Before this, summaries reached disk only with a browser board save, and a
// pod without a browser kept `{}` for hours (277f8, 10/07).
//
// Every summary change of a tracked workspace is queued; at most one write per `intervalMs` per workspace goes out
// with the newest summary of each task. The write (`persistWorkspaceSessionSummaries`) merges into what's on disk
// under the workspace lock, newer summary per task wins (src/state/session-summary-merge.ts), and touches neither the
// board nor its revision: this is not a writer of card columns.
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";

export const DEFAULT_SESSION_SUMMARY_PERSIST_INTERVAL_MS = 1000;

export type SessionSummaryPersisterSessions = Pick<TerminalSessionManager, "onSummary">;

export interface CreateSessionSummaryPersisterDependencies {
	/** Merges the summaries into the workspace's sessions.json; false when the workspace is no longer registered. */
	persist: (workspaceId: string, summaries: Record<string, RuntimeTaskSessionSummary>) => Promise<boolean>;
	intervalMs?: number;
	warn?: (message: string) => void;
}

export interface SessionSummaryPersister {
	/** Follows a workspace's session summaries; replaces an earlier subscription for the same workspace. */
	trackWorkspace: (workspaceId: string, sessions: SessionSummaryPersisterSessions) => void;
	/** Stops following the workspace and drops its queued summaries (the project is being removed). */
	untrackWorkspace: (workspaceId: string) => void;
	/** Writes every queued summary now and resolves when all writes have settled. */
	flush: () => Promise<void>;
	/** Stops following every workspace, then flushes. Summaries after this (sessions stopping at shutdown) stay off disk. */
	close: () => Promise<void>;
}

interface TrackedWorkspace {
	sessions: SessionSummaryPersisterSessions;
	pending: Map<string, RuntimeTaskSessionSummary>;
	timer: ReturnType<typeof setTimeout> | null;
	writing: Promise<void> | null;
	unsubscribe: () => void;
}

export function createSessionSummaryPersister(
	deps: CreateSessionSummaryPersisterDependencies,
): SessionSummaryPersister {
	const intervalMs = deps.intervalMs ?? DEFAULT_SESSION_SUMMARY_PERSIST_INTERVAL_MS;
	const tracked = new Map<string, TrackedWorkspace>();
	let closed = false;

	const write = (workspaceId: string, workspace: TrackedWorkspace): Promise<void> => {
		if (workspace.timer) {
			clearTimeout(workspace.timer);
			workspace.timer = null;
		}
		if (workspace.writing) {
			// The write in flight schedules the next one when it ends; a flush waits for both.
			return workspace.writing.then(() => (workspace.pending.size > 0 ? write(workspaceId, workspace) : undefined));
		}
		if (workspace.pending.size === 0) {
			return Promise.resolve();
		}
		const summaries = Object.fromEntries(workspace.pending);
		workspace.pending.clear();
		workspace.writing = deps
			.persist(workspaceId, summaries)
			.then(
				() => undefined,
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					deps.warn?.(`Could not persist session summaries of workspace ${workspaceId}: ${message}`);
					// Keep them for the next write unless a newer summary arrived meanwhile.
					for (const [taskId, summary] of Object.entries(summaries)) {
						if (!workspace.pending.has(taskId)) {
							workspace.pending.set(taskId, summary);
						}
					}
				},
			)
			.finally(() => {
				workspace.writing = null;
				if (workspace.pending.size > 0 && tracked.get(workspaceId) === workspace) {
					schedule(workspaceId, workspace);
				}
			});
		return workspace.writing;
	};

	const schedule = (workspaceId: string, workspace: TrackedWorkspace): void => {
		if (closed || workspace.timer || workspace.writing) {
			return;
		}
		workspace.timer = setTimeout(() => {
			workspace.timer = null;
			void write(workspaceId, workspace);
		}, intervalMs);
	};

	const untrackWorkspace = (workspaceId: string): void => {
		const workspace = tracked.get(workspaceId);
		if (!workspace) {
			return;
		}
		tracked.delete(workspaceId);
		workspace.unsubscribe();
		if (workspace.timer) {
			clearTimeout(workspace.timer);
			workspace.timer = null;
		}
		workspace.pending.clear();
	};

	const trackWorkspace = (workspaceId: string, sessions: SessionSummaryPersisterSessions): void => {
		if (closed || tracked.get(workspaceId)?.sessions === sessions) {
			return;
		}
		untrackWorkspace(workspaceId);
		const workspace: TrackedWorkspace = {
			sessions,
			pending: new Map(),
			timer: null,
			writing: null,
			unsubscribe: () => {},
		};
		workspace.unsubscribe = sessions.onSummary((summary) => {
			workspace.pending.set(summary.taskId, summary);
			schedule(workspaceId, workspace);
		});
		tracked.set(workspaceId, workspace);
	};

	const flush = async (): Promise<void> => {
		await Promise.all(Array.from(tracked.entries(), ([workspaceId, workspace]) => write(workspaceId, workspace)));
	};

	const close = async (): Promise<void> => {
		if (closed) {
			return;
		}
		closed = true;
		const workspaces = Array.from(tracked.entries());
		for (const [, workspace] of workspaces) {
			workspace.unsubscribe();
		}
		await Promise.all(workspaces.map(([workspaceId, workspace]) => write(workspaceId, workspace)));
		tracked.clear();
	};

	return { trackWorkspace, untrackWorkspace, flush, close };
}
