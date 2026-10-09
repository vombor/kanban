import { describe, expect, it } from "vitest";

import { moveTaskToColumn, trashTaskAndGetReadyLinkedTaskIds } from "@/state/board-state";
import { capturePendingDoneMove, isPendingDoneMoveSettled, withoutPendingDoneMoves } from "@/state/pending-done-moves";
import type { BoardCard, BoardData } from "@/types";

function createTask(taskId: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: `Prompt ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [createTask("task-linked", 1), createTask("task-other", 2)] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [createTask("task-a", 3), createTask("task-b", 4)] },
			{ id: "trash", title: "Done", cards: [createTask("task-old", 0)] },
		],
		dependencies: [
			{ id: "dep-1", fromTaskId: "task-linked", toTaskId: "task-b", createdAt: 5 },
			{ id: "dep-2", fromTaskId: "task-other", toTaskId: "task-a", createdAt: 6 },
		],
	};
}

function sortedDependencyIds(board: BoardData): string[] {
	return board.dependencies.map((dependency) => dependency.id).sort();
}

describe("pending Done moves", () => {
	it("takes an optimistic Done move back out of the board, links included", () => {
		const board = createBoard();
		const move = capturePendingDoneMove(board, "task-b");
		if (!move) {
			throw new Error("Expected a pending move.");
		}
		const optimistic = trashTaskAndGetReadyLinkedTaskIds(board, "task-b").board;
		// task-linked still waits in Backlog, so its link to the Done card stays (fan-in).
		expect(sortedDependencyIds(optimistic)).toEqual(["dep-1", "dep-2"]);

		const restored = withoutPendingDoneMoves(optimistic, [move]);

		expect(restored.columns).toEqual(board.columns);
		expect(sortedDependencyIds(restored)).toEqual(["dep-1", "dep-2"]);
	});

	it("keeps unrelated local edits while removing the move", () => {
		const board = createBoard();
		const move = capturePendingDoneMove(board, "task-a");
		if (!move) {
			throw new Error("Expected a pending move.");
		}
		const edited = moveTaskToColumn(board, "task-other", "in_progress").board;
		const optimistic = trashTaskAndGetReadyLinkedTaskIds(edited, "task-a").board;

		const restored = withoutPendingDoneMoves(optimistic, [move]);

		expect(restored.columns.find((column) => column.id === "in_progress")?.cards.map((card) => card.id)).toEqual([
			"task-other",
		]);
		expect(restored.columns.find((column) => column.id === "review")?.cards.map((card) => card.id)).toEqual([
			"task-a",
			"task-b",
		]);
	});

	it("ignores a move whose card has left Done since", () => {
		const board = createBoard();
		const move = capturePendingDoneMove(board, "task-a");
		if (!move) {
			throw new Error("Expected a pending move.");
		}
		const optimistic = trashTaskAndGetReadyLinkedTaskIds(board, "task-a").board;
		const restoredByUser = moveTaskToColumn(optimistic, "task-a", "in_progress").board;

		expect(withoutPendingDoneMoves(restoredByUser, [move])).toBe(restoredByUser);
	});

	it("does not capture a card that is already in Done", () => {
		expect(capturePendingDoneMove(createBoard(), "task-old")).toBeNull();
	});

	it("is settled once the runtime board shows the card in Done", () => {
		const board = createBoard();
		const move = capturePendingDoneMove(board, "task-a");
		if (!move) {
			throw new Error("Expected a pending move.");
		}
		expect(isPendingDoneMoveSettled(board, move)).toBe(false);
		expect(isPendingDoneMoveSettled(trashTaskAndGetReadyLinkedTaskIds(board, "task-a").board, move)).toBe(true);
	});
});
