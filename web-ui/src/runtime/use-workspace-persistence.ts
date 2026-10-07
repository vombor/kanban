import { useCallback, useEffect, useRef, useState } from "react";
import type {
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
} from "@/runtime/types";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import { isPendingDoneMoveSettled, type PendingDoneMove, withoutPendingDoneMoves } from "@/state/pending-done-moves";
import type { BoardData } from "@/types";

const WORKSPACE_STATE_PERSIST_DEBOUNCE_MS = 120;
/**
 * How long a held Done move may wait for the runtime's broadcast after the
 * runtime accepted it. Past this the broadcast is presumed lost and the
 * workspace is refetched, so the move settles instead of the next edit
 * conflicting.
 */
export const PENDING_DONE_MOVE_SETTLE_TIMEOUT_MS = 2_000;

export interface UseWorkspacePersistenceParams {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectId: string | null;
	workspaceRevision: number | null;
	hydrationNonce: number;
	canPersistWorkspaceState: boolean;
	isDocumentVisible: boolean;
	isWorkspaceStateRefreshing: boolean;
	persistWorkspaceState: (input: {
		workspaceId: string;
		payload: RuntimeWorkspaceStateSaveRequest;
	}) => Promise<RuntimeWorkspaceStateResponse>;
	refetchWorkspaceState: () => Promise<unknown>;
	onWorkspaceRevisionChange: (revision: number) => void;
	onWorkspaceStateConflict?: (input: { workspaceId: string; currentRevision: number }) => void;
}

export interface UseWorkspacePersistenceResult {
	/**
	 * Saves pending local board edits now (without any pending Done moves) and
	 * resolves once they are persisted. Callers that hand a board change to the
	 * runtime flush first, so the runtime's write cannot race a debounced save.
	 */
	flushWorkspaceState: () => Promise<void>;
	/**
	 * Keeps an optimistic Done move out of every save until the runtime's
	 * board shows it. The runtime's Done workflow is the only writer of it.
	 */
	holdPendingDoneMove: (move: PendingDoneMove) => void;
	/** Drops a held Done move, e.g. when the runtime refused it. */
	releasePendingDoneMove: (taskId: string) => void;
	/**
	 * Called once the runtime accepted the move. If no runtime board showing it
	 * arrives in time, the workspace is refetched.
	 */
	awaitPendingDoneMoveSettled: (taskId: string) => void;
}

/** Order-insensitive for links: moving a card out of and back into a column reorders them. */
function serializeBoardForComparison(board: BoardData): string {
	const dependencies = [...board.dependencies].sort((first, second) => first.id.localeCompare(second.id));
	return JSON.stringify({ ...board, dependencies });
}

export function useWorkspacePersistence({
	board,
	sessions,
	currentProjectId,
	workspaceRevision,
	hydrationNonce,
	canPersistWorkspaceState,
	isDocumentVisible,
	isWorkspaceStateRefreshing,
	persistWorkspaceState,
	refetchWorkspaceState,
	onWorkspaceRevisionChange,
	onWorkspaceStateConflict,
}: UseWorkspacePersistenceParams): UseWorkspacePersistenceResult {
	const [persistCycle, setPersistCycle] = useState(0);
	const skipNextPersistRef = useRef(false);
	const latestHydrationNonceRef = useRef(hydrationNonce);
	const latestPersistRequestIdRef = useRef(0);
	const persistInFlightRef = useRef<Promise<void> | null>(null);
	const persistQueuedRef = useRef(false);
	const currentProjectIdRef = useRef<string | null>(currentProjectId);
	const sessionsRef = useRef(sessions);
	const boardRef = useRef(board);
	const workspaceRevisionRef = useRef(workspaceRevision);
	const lastPersistedBoardRef = useRef<BoardData | null>(null);
	const lastPersistedSnapshotRef = useRef<string | null>(null);
	const lastPersistedWorkspaceIdRef = useRef<string | null>(null);
	const pendingDoneMovesRef = useRef(new Map<string, PendingDoneMove>());
	const settleTimersRef = useRef(new Map<string, number>());

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	useEffect(() => {
		workspaceRevisionRef.current = workspaceRevision;
	}, [workspaceRevision]);

	useEffect(() => {
		currentProjectIdRef.current = currentProjectId;
		if (lastPersistedWorkspaceIdRef.current !== currentProjectId) {
			lastPersistedWorkspaceIdRef.current = currentProjectId;
			lastPersistedBoardRef.current = null;
			lastPersistedSnapshotRef.current = null;
			pendingDoneMovesRef.current.clear();
		}
	}, [currentProjectId]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	useEffect(() => {
		if (latestHydrationNonceRef.current === hydrationNonce) {
			return;
		}
		latestHydrationNonceRef.current = hydrationNonce;
		skipNextPersistRef.current = true;
		lastPersistedWorkspaceIdRef.current = currentProjectId;
		lastPersistedBoardRef.current = board;
		lastPersistedSnapshotRef.current = serializeBoardForComparison(board);
		// Runtime state is the truth: a Done move it now shows is no longer pending.
		for (const [taskId, move] of pendingDoneMovesRef.current) {
			if (isPendingDoneMoveSettled(board, move)) {
				pendingDoneMovesRef.current.delete(taskId);
			}
		}
	}, [board, currentProjectId, hydrationNonce]);

	/**
	 * Saves `boardToPersist` minus the pending Done moves. Resolves without a
	 * request when that equals what the runtime already has.
	 */
	const persistBoard = useCallback(
		async (workspaceId: string, boardToPersist: BoardData): Promise<void> => {
			const expectedRevision = workspaceRevisionRef.current;
			if (expectedRevision == null) {
				return;
			}
			const payloadBoard = withoutPendingDoneMoves(boardToPersist, pendingDoneMovesRef.current.values());
			const payloadSnapshot = serializeBoardForComparison(payloadBoard);
			if (
				lastPersistedWorkspaceIdRef.current === workspaceId &&
				lastPersistedSnapshotRef.current === payloadSnapshot
			) {
				lastPersistedBoardRef.current = boardToPersist;
				return;
			}
			const requestId = latestPersistRequestIdRef.current + 1;
			latestPersistRequestIdRef.current = requestId;
			const payload: RuntimeWorkspaceStateSaveRequest = {
				board: payloadBoard,
				sessions: sessionsRef.current,
				expectedRevision,
			};
			try {
				const saved = await persistWorkspaceState({ workspaceId, payload });
				if (requestId !== latestPersistRequestIdRef.current || currentProjectIdRef.current !== workspaceId) {
					return;
				}
				lastPersistedWorkspaceIdRef.current = workspaceId;
				lastPersistedBoardRef.current = boardToPersist;
				lastPersistedSnapshotRef.current = payloadSnapshot;
				workspaceRevisionRef.current = saved.revision;
				onWorkspaceRevisionChange(saved.revision);
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					if (requestId === latestPersistRequestIdRef.current && currentProjectIdRef.current === workspaceId) {
						workspaceRevisionRef.current = error.currentRevision;
						onWorkspaceRevisionChange(error.currentRevision);
						onWorkspaceStateConflict?.({
							workspaceId,
							currentRevision: error.currentRevision,
						});
					}
					if (currentProjectIdRef.current !== workspaceId) {
						return;
					}
					await refetchWorkspaceState();
					return;
				}
				// Keep the UI usable even if persistence is temporarily unavailable.
			}
		},
		[onWorkspaceRevisionChange, onWorkspaceStateConflict, persistWorkspaceState, refetchWorkspaceState],
	);

	const runPersist = useCallback(
		(workspaceId: string, boardToPersist: BoardData): Promise<void> => {
			const run = persistBoard(workspaceId, boardToPersist).finally(() => {
				if (persistInFlightRef.current === run) {
					persistInFlightRef.current = null;
				}
				if (persistQueuedRef.current) {
					persistQueuedRef.current = false;
					setPersistCycle((current) => current + 1);
				}
			});
			persistInFlightRef.current = run;
			return run;
		},
		[persistBoard],
	);

	useEffect(() => {
		if (!canPersistWorkspaceState || !isDocumentVisible || isWorkspaceStateRefreshing || workspaceRevision == null) {
			return;
		}
		if (persistInFlightRef.current) {
			persistQueuedRef.current = true;
			return;
		}
		if (skipNextPersistRef.current) {
			skipNextPersistRef.current = false;
			return;
		}
		if (
			currentProjectId != null &&
			lastPersistedWorkspaceIdRef.current === currentProjectId &&
			lastPersistedBoardRef.current === board
		) {
			return;
		}
		const timeoutId = window.setTimeout(() => {
			if (!currentProjectId) {
				return;
			}
			void runPersist(currentProjectId, board);
		}, WORKSPACE_STATE_PERSIST_DEBOUNCE_MS);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [
		board,
		canPersistWorkspaceState,
		currentProjectId,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		persistCycle,
		runPersist,
		workspaceRevision,
	]);

	const flushWorkspaceState = useCallback(async (): Promise<void> => {
		while (persistInFlightRef.current) {
			await persistInFlightRef.current;
		}
		const workspaceId = currentProjectIdRef.current;
		if (!workspaceId || !canPersistWorkspaceState) {
			return;
		}
		await runPersist(workspaceId, boardRef.current);
	}, [canPersistWorkspaceState, runPersist]);

	const holdPendingDoneMove = useCallback((move: PendingDoneMove) => {
		pendingDoneMovesRef.current.set(move.taskId, move);
	}, []);

	const releasePendingDoneMove = useCallback((taskId: string) => {
		pendingDoneMovesRef.current.delete(taskId);
	}, []);

	const awaitPendingDoneMoveSettled = useCallback(
		(taskId: string) => {
			if (!pendingDoneMovesRef.current.has(taskId)) {
				return;
			}
			window.clearTimeout(settleTimersRef.current.get(taskId));
			const timeoutId = window.setTimeout(() => {
				settleTimersRef.current.delete(taskId);
				if (pendingDoneMovesRef.current.has(taskId)) {
					void refetchWorkspaceState();
				}
			}, PENDING_DONE_MOVE_SETTLE_TIMEOUT_MS);
			settleTimersRef.current.set(taskId, timeoutId);
		},
		[refetchWorkspaceState],
	);

	useEffect(() => {
		const settleTimers = settleTimersRef.current;
		return () => {
			for (const timeoutId of settleTimers.values()) {
				window.clearTimeout(timeoutId);
			}
			settleTimers.clear();
		};
	}, []);

	return { flushWorkspaceState, holdPendingDoneMove, releasePendingDoneMove, awaitPendingDoneMoveSettled };
}
