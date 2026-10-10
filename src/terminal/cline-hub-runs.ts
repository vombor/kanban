// Ends the runs a card's worktree still has in Cline's shared hub once the card's TUI is gone (issue #28): Done,
// task delete and project removal (all through the server's prepareTaskProcessReap) end every running session of the
// worktree; a Cline card's TUI that exits, or that died with the old server, ends the sessions its own run started
// (src/server/cline-hub-run-follower.ts). The hub itself is never signalled: it serves every Cline card.
//
// A session is the card's when its `<id>.json` names the worktree (cwd / workspace root) and still says "running";
// the hub's own `session.get` decides whether it really still runs (cline-hub-client.ts). Nothing is opened when no
// session file of the worktree says "running", so a Done of a non-Cline card costs one directory read.
import {
	abortClineHubRun,
	type ClineHubAbortOutcome,
	type ClineHubConnection,
	type ClineHubDiscovery,
	connectClineHub,
	getClineHubDiscoveryPath,
	readClineHubDiscovery,
} from "./cline-hub-client";
import {
	type ClineRunningSession,
	type ClineRunningSessionReader,
	createClineSessionFileReader,
	getClineSessionsPath,
} from "./cline-session-files";

/** How much earlier than Kanban's `startedAt` a run's first Cline session may say it started (same clock, rounding). */
export const CLINE_RUN_SESSION_START_SLACK_MS = 5_000;

export interface CancelClineHubRunsRequest {
	workspaceId: string;
	taskId: string;
	/** The card's worktree candidates (getTaskWorktreeCandidatePaths). */
	worktreePaths: readonly string[];
	/**
	 * Only sessions started in this window (a run's own sessions: from its `startedAt` to its exit), so a relaunch's
	 * new session in the same worktree is never ended. Omitted: every running session of the worktree (Done, delete).
	 */
	window?: { from: number | null; to: number };
	/** Why, as the hub records it with the abort. */
	reason: string;
}

export type ClineHubRunCancellationOutcome = ClineHubAbortOutcome | "hub_unavailable" | "failed";

export interface ClineHubRunCancellation {
	sessionId: string;
	outcome: ClineHubRunCancellationOutcome;
	error?: string;
}

export interface ClineHubRunCanceller {
	cancelRuns: (request: CancelClineHubRunsRequest) => Promise<ClineHubRunCancellation[]>;
}

export interface ClineHubRunCancellerDependencies {
	/** Cline's data dir (`agents.cline.dataDir` resolved the Cline CLI's way), read per call. */
	loadClineDataDir: () => Promise<string>;
	log: (message: string) => void;
	reader?: ClineRunningSessionReader;
	readDiscovery?: (discoveryPath: string) => Promise<ClineHubDiscovery | null>;
	connect?: (discovery: ClineHubDiscovery) => Promise<ClineHubConnection>;
	abort?: typeof abortClineHubRun;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isInWindow(session: ClineRunningSession, window: CancelClineHubRunsRequest["window"]): boolean {
	if (!window) {
		return true;
	}
	if (session.startedAt === null) {
		return false; // can't tell whose it is: a relaunch's session must never be ended
	}
	const from = window.from === null ? Number.NEGATIVE_INFINITY : window.from - CLINE_RUN_SESSION_START_SLACK_MS;
	return session.startedAt >= from && session.startedAt <= window.to;
}

export function createClineHubRunCanceller(deps: ClineHubRunCancellerDependencies): ClineHubRunCanceller {
	const reader = deps.reader ?? createClineSessionFileReader();
	const readDiscovery = deps.readDiscovery ?? readClineHubDiscovery;
	const connect = deps.connect ?? connectClineHub;
	const abort = deps.abort ?? abortClineHubRun;

	const cancelRuns = async (request: CancelClineHubRunsRequest): Promise<ClineHubRunCancellation[]> => {
		const dataDir = await deps.loadClineDataDir();
		const sessions = (await reader.readRunningSessions(getClineSessionsPath(dataDir), request.worktreePaths)).filter(
			(session) => isInWindow(session, request.window),
		);
		if (sessions.length === 0) {
			return [];
		}
		const card = `${request.workspaceId}/${request.taskId}`;
		const ids = sessions.map((session) => session.sessionId).join(", ");
		const discoveryPath = getClineHubDiscoveryPath(dataDir);
		const discovery = await readDiscovery(discoveryPath);
		if (!discovery) {
			deps.log(
				`Cline hub run(s) ${ids} of ${card} say "running" but no Cline hub discovery file is usable at ${discoveryPath}; not ended.`,
			);
			return sessions.map(({ sessionId }) => ({ sessionId, outcome: "hub_unavailable" }));
		}
		let connection: ClineHubConnection;
		try {
			connection = await connect(discovery);
		} catch (error) {
			const message = toErrorMessage(error);
			deps.log(`Could not end Cline hub run(s) ${ids} of ${card}: ${message}`);
			return sessions.map(({ sessionId }) => ({ sessionId, outcome: "hub_unavailable", error: message }));
		}
		const results: ClineHubRunCancellation[] = [];
		try {
			for (const { sessionId } of sessions) {
				try {
					const outcome = await abort(connection, sessionId, request.reason);
					results.push({ sessionId, outcome });
					deps.log(
						outcome === "ended"
							? `Ended Cline hub run ${sessionId} of ${card} (${request.reason}).`
							: outcome === "not_found"
								? `Cline hub run ${sessionId} of ${card} is unknown to the hub (session file still says "running").`
								: `Cline hub run ${sessionId} of ${card} still runs after every abort (${request.reason}).`,
					);
				} catch (error) {
					const message = toErrorMessage(error);
					results.push({ sessionId, outcome: "failed", error: message });
					deps.log(`Could not end Cline hub run ${sessionId} of ${card}: ${message}`);
				}
			}
		} finally {
			connection.close();
		}
		return results;
	};

	return { cancelRuns };
}
