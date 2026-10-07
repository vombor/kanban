// Session sync: the runtime moves cards between In Progress and Review when their task session changes state.
//
// Before this module the browser made these moves (use-board-interactions.ts), so with no tab open nothing
// moved, and with a tab open the legacy kit's column-sync service and the browser both moved cards and could
// undo each other's moves. The rules are the browser's, with the kit's guard:
//
//   session "awaiting_review" + card in In Progress → top of Review
//   session "running"         + card in Review      → top of In Progress
//
// - Only a summary newer than the card moves it (`summary.updatedAt > card.updatedAt`). An older summary is stale:
//   a rework typed into a card whose old session already ended, or a card someone moved by hand after the
//   session last changed. Ported from archive/devteam-kit:services/kanban-column-sync.mjs@6da71597 (58f74, 10/05).
// - An interrupted session never moves its card, and never to Done. The browser's "interrupted → trash" move
//   trashed card 62a99 on 10/05, and the kit deliberately did not copy it. Interrupted cards stay where they are.
// - A card moves to Review only once its summary says awaiting_review, so the column and the summary always
//   agree. Code that detects a turn end on its own (the cline-cli turn detector, P2-2) must end the turn in the
//   session state machine (`transitionToReview`) and let this module move the card. Moving only the card leaves
//   a Review card whose summary still says "running", and that card gets moved straight back. Ported from
//   archive/devteam-kit:services/kanban-column-sync.mjs@acf45dce (calibration QA cards bounced every 5 min, 10/06).
// - A Review card that auto-review has armed (`autoReviewEnabled` and a `pendingGitAction`) stays in Review while
//   its session runs. The reconciler typed the commit/PR prompt, so the agent runs again. Moving the card would
//   make the reconciler disarm it (an armed card outside Review), and the card would then never reach Done, or it
//   would get the prompt typed again on every round trip. The reconciler owns the card until Done or until the
//   arming goes stale and the reconciler clears it.
//
// It runs on every session state change, when a workspace's sessions are first tracked, and on a 10 s sweep
// (the kit's interval) that catches a summary that got newer than its card without a state change. Each move is
// one `mutateWorkspaceState` step (board lock, new revision) followed by a broadcast, as in the Done workflow.
//
// The `sessionSync` setting (global config.json, default true in this fork; src/config/session-sync-config.ts) is
// read once at startup. When it is off the server never creates this module, and the browser, which gets the same
// value in the runtime config, makes the moves itself. Turning it off: docs/fork/session-sync.md.
//
// The legacy kit's column-sync may keep running next to this until the cutover disables it
// (`run/column-sync.disabled`). The two can't fight over these moves. Both apply the same rules with the same
// guard, so they agree on every move. The kit saves the whole board with `expectedRevision`: if this module moved
// the card first, the kit's save fails with a conflict, and on its next tick the card is already in place. The
// kit's own Cline-CLI moves end the turn first (`hooks.ingest to_review`), so this module sees a state change
// and moves the card the same way. If the kit's to_review call fails, it moves only the card, and this module
// moves it back once the summary changes again. That is the bounce the kit had with the browser, so turn
// off the kit's column-sync only after the cline-cli turn detector (P2-2) is in.

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { moveTaskToTopOfColumn } from "../core/task-board-mutations";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { MutateWorkspaceState } from "./task-trash-workflow";

const SESSION_COLUMN_SYNC_SWEEP_INTERVAL_MS = 10_000;

export interface SessionColumnMove {
	taskId: string;
	from: RuntimeBoardColumnId;
	to: RuntimeBoardColumnId;
	sessionState: RuntimeTaskSessionState;
}

export type SessionColumnSyncSessions = Pick<TerminalSessionManager, "onSummary" | "listSummaries">;

export interface SessionColumnSyncWorkspace {
	workspaceId: string;
	workspacePath: string | null;
}

export interface CreateSessionColumnSyncDependencies {
	listWorkspaces: () => SessionColumnSyncWorkspace[];
	mutateWorkspaceState: MutateWorkspaceState;
	/** Broadcasts the new board to connected browsers. */
	onBoardMutated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	/** Called after moves were saved (tests, diagnostics). */
	onMoved?: (workspaceId: string, moves: SessionColumnMove[]) => void;
	sweepIntervalMs?: number;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface SessionColumnSync {
	/** Starts the sweep and syncs every workspace tracked so far. */
	start: () => void;
	/** Follows a workspace's session summaries; replaces an earlier subscription for the same workspace. */
	trackWorkspace: (workspaceId: string, sessions: SessionColumnSyncSessions) => void;
	untrackWorkspace: (workspaceId: string) => void;
	/** Runs one sync of a tracked workspace and resolves when it (and any sync queued meanwhile) has settled. */
	syncWorkspace: (workspaceId: string) => Promise<void>;
	close: () => void;
}

function targetColumnFor(state: RuntimeTaskSessionState, columnId: RuntimeBoardColumnId): RuntimeBoardColumnId | null {
	if (state === "awaiting_review" && columnId === "in_progress") {
		return "review";
	}
	if (state === "running" && columnId === "review") {
		return "in_progress";
	}
	return null;
}

/** Auto-review typed a git action prompt into this card and waits for HEAD to move (auto-review-reconciler.ts). */
function isArmedByAutoReview(card: RuntimeBoardCard): boolean {
	return card.autoReviewEnabled === true && Boolean(card.pendingGitAction);
}

function canMoveCard(state: RuntimeTaskSessionState): boolean {
	return state === "awaiting_review" || state === "running";
}

function indexCards(board: RuntimeBoardData): Map<string, { columnId: RuntimeBoardColumnId; card: RuntimeBoardCard }> {
	const index = new Map<string, { columnId: RuntimeBoardColumnId; card: RuntimeBoardCard }>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			index.set(card.id, { columnId: column.id, card });
		}
	}
	return index;
}

/** The moves the session summaries ask for on this board. Pure; summaries without a card are ignored. */
export function planSessionColumnMoves(
	board: RuntimeBoardData,
	summaries: Iterable<RuntimeTaskSessionSummary>,
): SessionColumnMove[] {
	const cards = indexCards(board);
	const moves: SessionColumnMove[] = [];
	for (const summary of summaries) {
		const location = cards.get(summary.taskId);
		if (!location) {
			continue;
		}
		const to = targetColumnFor(summary.state, location.columnId);
		if (!to || !(summary.updatedAt > location.card.updatedAt)) {
			continue;
		}
		if (to === "in_progress" && isArmedByAutoReview(location.card)) {
			continue;
		}
		moves.push({ taskId: summary.taskId, from: location.columnId, to, sessionState: summary.state });
	}
	return moves;
}

export function applySessionColumnMoves(
	board: RuntimeBoardData,
	moves: readonly SessionColumnMove[],
	now: number,
): { board: RuntimeBoardData; applied: SessionColumnMove[] } {
	let next = board;
	const applied: SessionColumnMove[] = [];
	for (const move of moves) {
		const moved = moveTaskToTopOfColumn(next, move.taskId, move.to, now);
		if (moved.moved && moved.fromColumnId === move.from) {
			next = moved.board;
			applied.push(move);
		}
	}
	return { board: next, applied };
}

interface TrackedWorkspace {
	sessions: SessionColumnSyncSessions;
	unsubscribe: () => void;
	lastStateByTaskId: Map<string, RuntimeTaskSessionState>;
	syncPromise: Promise<void> | null;
	pendingSync: boolean;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSessionColumnSync(deps: CreateSessionColumnSyncDependencies): SessionColumnSync {
	const tracked = new Map<string, TrackedWorkspace>();
	const now = (): number => deps.now?.() ?? Date.now();
	let sweepTimer: NodeJS.Timeout | null = null;
	let started = false;
	let disposed = false;

	const syncOnce = async (workspaceId: string, workspace: TrackedWorkspace): Promise<void> => {
		// Most cycles have nothing that could move; they cost no board read.
		if (!workspace.sessions.listSummaries().some((summary) => canMoveCard(summary.state))) {
			return;
		}
		const workspacePath =
			deps.listWorkspaces().find((candidate) => candidate.workspaceId === workspaceId)?.workspacePath ?? null;
		if (!workspacePath) {
			return;
		}
		if (tracked.get(workspaceId) !== workspace) {
			return;
		}
		const response = await deps.mutateWorkspaceState<SessionColumnMove[]>(workspacePath, (state) => {
			// Summaries are read inside the board step, so the plan uses the newest of both.
			const moves = planSessionColumnMoves(state.board, workspace.sessions.listSummaries());
			const { board, applied } = applySessionColumnMoves(state.board, moves, now());
			if (applied.length === 0) {
				return { board: state.board, value: [], save: false };
			}
			return { board, value: applied };
		});
		if (response.value.length === 0) {
			return;
		}
		deps.onMoved?.(workspaceId, response.value);
		try {
			await deps.onBoardMutated?.(workspaceId, workspacePath);
		} catch {
			// Broadcast is best-effort; the persisted board is already correct.
		}
	};

	const syncWorkspace = async (workspaceId: string): Promise<void> => {
		const workspace = tracked.get(workspaceId);
		if (!workspace || disposed) {
			return;
		}
		// One sync chain per workspace. A request while one runs queues one more cycle on the same chain.
		if (workspace.syncPromise) {
			workspace.pendingSync = true;
			await workspace.syncPromise;
			return;
		}
		const chain = (async () => {
			do {
				workspace.pendingSync = false;
				await syncOnce(workspaceId, workspace);
			} while (workspace.pendingSync && !disposed && tracked.get(workspaceId) === workspace);
		})()
			.catch((error) => {
				deps.warn?.(`Session sync failed for ${workspaceId}: ${toErrorMessage(error)}`);
			})
			.finally(() => {
				workspace.syncPromise = null;
			});
		workspace.syncPromise = chain;
		await chain;
	};

	const untrackWorkspace = (workspaceId: string): void => {
		const workspace = tracked.get(workspaceId);
		if (!workspace) {
			return;
		}
		tracked.delete(workspaceId);
		try {
			workspace.unsubscribe();
		} catch {
			// Ignore listener cleanup errors during project removal.
		}
	};

	const trackWorkspace = (workspaceId: string, sessions: SessionColumnSyncSessions): void => {
		if (disposed) {
			return;
		}
		const existing = tracked.get(workspaceId);
		if (existing?.sessions === sessions) {
			return;
		}
		untrackWorkspace(workspaceId);
		const lastStateByTaskId = new Map<string, RuntimeTaskSessionState>();
		for (const summary of sessions.listSummaries()) {
			lastStateByTaskId.set(summary.taskId, summary.state);
		}
		const workspace: TrackedWorkspace = {
			sessions,
			lastStateByTaskId,
			syncPromise: null,
			pendingSync: false,
			unsubscribe: () => {},
		};
		workspace.unsubscribe = sessions.onSummary((summary) => {
			const previousState = workspace.lastStateByTaskId.get(summary.taskId);
			workspace.lastStateByTaskId.set(summary.taskId, summary.state);
			// Output and hook activity update summaries many times a second; only a state change can ask for a move.
			if (started && previousState !== summary.state && canMoveCard(summary.state)) {
				void syncWorkspace(workspaceId);
			}
		});
		tracked.set(workspaceId, workspace);
		if (started) {
			void syncWorkspace(workspaceId);
		}
	};

	return {
		start: () => {
			if (disposed || started) {
				return;
			}
			started = true;
			sweepTimer = setInterval(() => {
				for (const workspaceId of tracked.keys()) {
					void syncWorkspace(workspaceId);
				}
			}, deps.sweepIntervalMs ?? SESSION_COLUMN_SYNC_SWEEP_INTERVAL_MS);
			sweepTimer.unref();
			for (const workspaceId of tracked.keys()) {
				void syncWorkspace(workspaceId);
			}
		},
		trackWorkspace,
		untrackWorkspace,
		syncWorkspace,
		close: () => {
			disposed = true;
			if (sweepTimer) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
			for (const workspaceId of [...tracked.keys()]) {
				untrackWorkspace(workspaceId);
			}
		},
	};
}
