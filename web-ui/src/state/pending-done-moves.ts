import type { BoardCard, BoardColumnId, BoardData, BoardDependency } from "@/types";

/**
 * A Done move the browser shows optimistically while the runtime's Done
 * workflow (src/server/task-trash-workflow.ts) performs the real one. The
 * runtime is the only writer of that move, so the browser keeps enough of the
 * card's previous placement to take the move back out of anything it saves.
 */
export interface PendingDoneMove {
	taskId: string;
	columnId: BoardColumnId;
	index: number;
	card: BoardCard;
	/** Links involving the card; moving a card to Done drops them from the board. */
	dependencies: BoardDependency[];
}

export function capturePendingDoneMove(board: BoardData, taskId: string): PendingDoneMove | null {
	for (const column of board.columns) {
		const index = column.cards.findIndex((card) => card.id === taskId);
		const card = column.cards[index];
		if (!card) {
			continue;
		}
		if (column.id === "trash") {
			return null;
		}
		return {
			taskId,
			columnId: column.id,
			index,
			card,
			dependencies: board.dependencies.filter(
				(dependency) => dependency.fromTaskId === taskId || dependency.toTaskId === taskId,
			),
		};
	}
	return null;
}

function isCardInDone(board: BoardData, taskId: string): boolean {
	return board.columns.some((column) => column.id === "trash" && column.cards.some((card) => card.id === taskId));
}

function hasCard(board: BoardData, taskId: string): boolean {
	return board.columns.some((column) => column.cards.some((card) => card.id === taskId));
}

/**
 * Returns the board as it would be without the pending Done moves: each card
 * still sitting in Done goes back to its previous column and position, with
 * its links. Moves whose card has left Done since are ignored.
 */
export function withoutPendingDoneMoves(board: BoardData, moves: Iterable<PendingDoneMove>): BoardData {
	let nextBoard = board;
	for (const move of moves) {
		if (!isCardInDone(nextBoard, move.taskId)) {
			continue;
		}
		const columns = nextBoard.columns.map((column) => {
			const cards = column.cards.filter((card) => card.id !== move.taskId);
			if (column.id !== move.columnId) {
				return cards.length === column.cards.length ? column : { ...column, cards };
			}
			const insertAt = Math.min(move.index, cards.length);
			return { ...column, cards: [...cards.slice(0, insertAt), move.card, ...cards.slice(insertAt)] };
		});
		const restored: BoardData = { ...nextBoard, columns };
		const existingDependencyIds = new Set(restored.dependencies.map((dependency) => dependency.id));
		const missingDependencies = move.dependencies.filter(
			(dependency) =>
				!existingDependencyIds.has(dependency.id) &&
				hasCard(restored, dependency.fromTaskId) &&
				hasCard(restored, dependency.toTaskId),
		);
		nextBoard =
			missingDependencies.length > 0
				? { ...restored, dependencies: [...restored.dependencies, ...missingDependencies] }
				: restored;
	}
	return nextBoard;
}

/** True when the runtime's board already shows the card in Done (or no longer has it). */
export function isPendingDoneMoveSettled(board: BoardData, move: PendingDoneMove): boolean {
	return isCardInDone(board, move.taskId) || !hasCard(board, move.taskId);
}
