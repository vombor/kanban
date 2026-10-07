import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { UseWorkspacePersistenceResult } from "@/runtime/use-workspace-persistence";
import {
	addTaskDependency,
	findCardSelection,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
} from "@/state/board-state";
import { capturePendingDoneMove, withoutPendingDoneMoves } from "@/state/pending-done-moves";
import { trackTaskDependencyCreated, trackTasksAutoStartedFromDependency } from "@/telemetry/events";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

export function useLinkedBacklogTaskActions({
	board,
	setBoard,
	setSelectedTaskId,
	trashTask,
	workspacePersistence,
	maybeRequestNotificationPermissionForTaskStart,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	trashTask: UseTaskSessionsResult["trashTask"];
	/** Keeps the optimistic Done move out of browser saves; the runtime writes it. */
	workspacePersistence: UseWorkspacePersistenceResult;
	maybeRequestNotificationPermissionForTaskStart: () => void;
}): {
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
} {
	const { flushWorkspaceState, holdPendingDoneMove, releasePendingDoneMove, awaitPendingDoneMoveSettled } =
		workspacePersistence;
	const boardRef = useRef(board);

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	const handleCreateDependency = useCallback(
		(fromTaskId: string, toTaskId: string) => {
			const result = addTaskDependency(boardRef.current, fromTaskId, toTaskId);
			if (!result.added) {
				const message =
					result.reason === "same_task"
						? "A task cannot be linked to itself."
						: result.reason === "duplicate"
							? "Link already exists."
							: result.reason === "trash_task"
								? "Links cannot include done tasks."
								: result.reason === "non_backlog"
									? "Links must include at least one Backlog task."
									: "Could not create link.";
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message,
					timeout: 3000,
				});
				return;
			}

			setBoard((currentBoard) => {
				const latestResult = addTaskDependency(currentBoard, fromTaskId, toTaskId);
				return latestResult.added ? latestResult.board : currentBoard;
			});
			trackTaskDependencyCreated();
		},
		[setBoard],
	);

	const handleDeleteDependency = useCallback(
		(dependencyId: string) => {
			setBoard((currentBoard) => {
				const removed = removeTaskDependency(currentBoard, dependencyId);
				return removed.removed ? removed.board : currentBoard;
			});
		},
		[setBoard],
	);

	const performMoveTaskToTrash = useCallback(
		async (task: BoardCard, currentBoard?: BoardData): Promise<void> => {
			const boardBeforeTrash = currentBoard ?? boardRef.current;
			// The runtime's Done workflow is the only writer of this move. The
			// browser shows it now but keeps it out of its own saves until the
			// runtime's board (broadcast or refetch) replaces the local one.
			const pendingMove = capturePendingDoneMove(boardBeforeTrash, task.id);
			if (pendingMove) {
				holdPendingDoneMove(pendingMove);
			}
			const trashed = trashTaskAndGetReadyLinkedTaskIds(boardBeforeTrash, task.id);
			if (trashed.moved) {
				setBoard((currentBoardState) => {
					const latestTrashResult = trashTaskAndGetReadyLinkedTaskIds(currentBoardState, task.id);
					return latestTrashResult.moved ? latestTrashResult.board : currentBoardState;
				});
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === task.id
						? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
						: currentSelectedTaskId,
				);
				if (trashed.readyTaskIds.length > 0) {
					maybeRequestNotificationPermissionForTaskStart();
				}
			}

			// Unrelated local edits still waiting for the debounced save land
			// first, so the runtime's write cannot make that save conflict.
			await flushWorkspaceState();
			const result = await trashTask(task.id);
			if (!result?.ok) {
				if (pendingMove) {
					releasePendingDoneMove(task.id);
					setBoard((currentBoardState) => withoutPendingDoneMoves(currentBoardState, [pendingMove]));
				}
				if (result?.error) {
					notifyError(result.error);
				}
				return;
			}
			if (pendingMove) {
				awaitPendingDoneMoveSettled(task.id);
			}
			for (const started of result.autoStartedTasks) {
				if (!started.ok) {
					notifyError(started.error ?? "Could not start task session.");
				} else if (started.warning) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: started.warning,
						timeout: 7000,
					});
				}
			}
			const startedTaskCount = result.autoStartedTasks.filter((started) => started.ok).length;
			if (startedTaskCount > 0) {
				trackTasksAutoStartedFromDependency(startedTaskCount);
			}
		},
		[
			awaitPendingDoneMoveSettled,
			flushWorkspaceState,
			holdPendingDoneMove,
			maybeRequestNotificationPermissionForTaskStart,
			releasePendingDoneMove,
			setBoard,
			setSelectedTaskId,
			trashTask,
		],
	);

	const requestMoveTaskToTrash = useCallback(
		async (taskId: string, _fromColumnId: BoardColumnId, options?: RequestMoveTaskToTrashOptions): Promise<void> => {
			const boardSnapshot = boardRef.current;
			const selection = findCardSelection(boardSnapshot, taskId);
			if (!selection) {
				return;
			}

			const moveSelectionIfOptimisticMoveIsConfirmed = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === taskId
						? getNextDetailTaskIdAfterTrashMove(boardSnapshot, taskId)
						: currentSelectedTaskId,
				);
			};

			if (options?.skipWorkingChangeWarning) {
				moveSelectionIfOptimisticMoveIsConfirmed();
				await performMoveTaskToTrash(selection.card, boardSnapshot);
				return;
			}

			moveSelectionIfOptimisticMoveIsConfirmed();
			await performMoveTaskToTrash(selection.card, boardSnapshot);
		},
		[performMoveTaskToTrash, setSelectedTaskId],
	);

	return {
		handleCreateDependency,
		handleDeleteDependency,
		confirmMoveTaskToTrash: async (task: BoardCard, currentBoard?: BoardData) => {
			await performMoveTaskToTrash(task, currentBoard);
		},
		requestMoveTaskToTrash,
	};
}
