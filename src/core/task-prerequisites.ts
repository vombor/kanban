// Fan-in for board links (issue #17): which prerequisites a Backlog card waits on, and whether all of them are Done.
//
// A link's `fromTaskId` is the Backlog card that waits; its `toTaskId` is the prerequisite. A prerequisite is
// satisfied when it is in Done (however it got there), or when it was deleted from the board while in Done
// (`doneTaskDeletedAt`, recorded by the delete itself, e.g. prune-done or clearing Done). Any other prerequisite is
// unsatisfied, including one that is not on the board without that record (deleted before it was Done, or never
// on the board): its work was never finished, so a card planned on it must not start by itself. Such a card shows
// the missing prerequisite and waits for a person to start it or remove the link.
import type { RuntimeBoardColumnId, RuntimeBoardData, RuntimeBoardDependency } from "./api-contract";

export interface TaskPrerequisiteStatus {
	/** Every prerequisite of the card. */
	total: number;
	/** Prerequisites that are Done (in Done, or deleted while Done). */
	done: number;
	/** Prerequisites on the board that are not Done yet. */
	waitingOnTaskIds: string[];
	/** Prerequisites no longer on the board that were not Done when deleted (or never on it): never satisfied. */
	missingTaskIds: string[];
}

function collectColumnIdsByTaskId(board: RuntimeBoardData): Map<string, RuntimeBoardColumnId> {
	const columnIdByTaskId = new Map<string, RuntimeBoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			columnIdByTaskId.set(card.id, column.id);
		}
	}
	return columnIdByTaskId;
}

function describePrerequisites(
	dependencies: readonly RuntimeBoardDependency[],
	columnIdByTaskId: ReadonlyMap<string, RuntimeBoardColumnId>,
	taskId: string,
): TaskPrerequisiteStatus | null {
	if (columnIdByTaskId.get(taskId) !== "backlog") {
		return null;
	}
	const seen = new Set<string>();
	const status: TaskPrerequisiteStatus = { total: 0, done: 0, waitingOnTaskIds: [], missingTaskIds: [] };
	for (const dependency of dependencies) {
		if (dependency.fromTaskId !== taskId || seen.has(dependency.toTaskId)) {
			continue;
		}
		seen.add(dependency.toTaskId);
		status.total += 1;
		const columnId = columnIdByTaskId.get(dependency.toTaskId);
		if (columnId === "trash" || (columnId === undefined && dependency.doneTaskDeletedAt !== undefined)) {
			status.done += 1;
		} else if (columnId === undefined) {
			status.missingTaskIds.push(dependency.toTaskId);
		} else {
			status.waitingOnTaskIds.push(dependency.toTaskId);
		}
	}
	return status.total > 0 ? status : null;
}

/** The prerequisites of a Backlog card; null for a card that is not in Backlog or has none. */
export function getTaskPrerequisiteStatus(board: RuntimeBoardData, taskId: string): TaskPrerequisiteStatus | null {
	return describePrerequisites(board.dependencies, collectColumnIdsByTaskId(board), taskId);
}

/** The prerequisites of every Backlog card that has any, keyed by card id. */
export function getBoardPrerequisiteStatuses(board: RuntimeBoardData): Map<string, TaskPrerequisiteStatus> {
	const columnIdByTaskId = collectColumnIdsByTaskId(board);
	const statuses = new Map<string, TaskPrerequisiteStatus>();
	for (const dependency of board.dependencies) {
		if (statuses.has(dependency.fromTaskId)) {
			continue;
		}
		const status = describePrerequisites(board.dependencies, columnIdByTaskId, dependency.fromTaskId);
		if (status) {
			statuses.set(dependency.fromTaskId, status);
		}
	}
	return statuses;
}

export function arePrerequisitesDone(status: TaskPrerequisiteStatus): boolean {
	return status.done === status.total;
}

/**
 * The links left once `deletedTaskIds` leave the board. A link whose waiting card is deleted goes. A link whose
 * prerequisite is deleted stays while its card waits in Backlog, so the card neither forgets the prerequisite nor
 * starts early: one deleted from Done is marked `doneTaskDeletedAt` (it counts as done), any other is left unmarked
 * (it never counts as done). `board` is the board before the delete.
 */
export function getDependenciesAfterTasksDeleted(
	board: RuntimeBoardData,
	deletedTaskIds: ReadonlySet<string>,
	now: number,
): RuntimeBoardDependency[] {
	const columnIdByTaskId = collectColumnIdsByTaskId(board);
	const dependencies: RuntimeBoardDependency[] = [];
	for (const dependency of board.dependencies) {
		if (deletedTaskIds.has(dependency.fromTaskId)) {
			continue;
		}
		if (!deletedTaskIds.has(dependency.toTaskId)) {
			dependencies.push(dependency);
			continue;
		}
		if (columnIdByTaskId.get(dependency.fromTaskId) !== "backlog") {
			continue;
		}
		const prerequisiteColumnId = columnIdByTaskId.get(dependency.toTaskId);
		dependencies.push(
			prerequisiteColumnId === "trash" && dependency.doneTaskDeletedAt === undefined
				? { ...dependency, doneTaskDeletedAt: now }
				: dependency,
		);
	}
	return dependencies;
}
