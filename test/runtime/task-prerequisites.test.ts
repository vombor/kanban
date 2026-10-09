import { describe, expect, it } from "vitest";

import type { RuntimeBoardColumnId, RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	deleteTasksFromBoard,
	getTaskColumnId,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTaskDependencies,
} from "../../src/core/task-board-mutations";
import { arePrerequisitesDone, getTaskPrerequisiteStatus } from "../../src/core/task-prerequisites";
import { createBoard, createCard } from "../utilities/workspace-state-store";

function link(id: string, fromTaskId: string, toTaskId: string) {
	return { id, fromTaskId, toTaskId, createdAt: 0 };
}

/** Backlog card D waits on Review cards A, B and C. */
function fanInBoard(): RuntimeBoardData {
	return createBoard(
		{
			backlog: [createCard({ id: "d" })],
			review: [createCard({ id: "a" }), createCard({ id: "b" }), createCard({ id: "c" })],
		},
		[link("l-a", "d", "a"), link("l-b", "d", "b"), link("l-c", "d", "c")],
	);
}

function trashInOrder(board: RuntimeBoardData, order: string[]): { board: RuntimeBoardData; ready: string[][] } {
	const ready: string[][] = [];
	let current = board;
	for (const taskId of order) {
		const trashed = trashTaskAndGetReadyLinkedTaskIds(current, taskId);
		expect(trashed.moved).toBe(true);
		ready.push(trashed.readyTaskIds);
		current = trashed.board;
	}
	return { board: current, ready };
}

function permutations<T>(items: T[]): T[][] {
	if (items.length <= 1) {
		return [items];
	}
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
	);
}

function columnOf(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	return getTaskColumnId(board, taskId);
}

describe("board links: fan-in", () => {
	it("starts a card with three prerequisites only after the third is Done", () => {
		const { board, ready } = trashInOrder(fanInBoard(), ["a", "b", "c"]);

		expect(ready).toEqual([[], [], ["d"]]);
		// Every link survives while D waits, so its count holds.
		expect(board.dependencies.map((dependency) => dependency.id)).toEqual(["l-a", "l-b", "l-c"]);
	});

	it("does not depend on the order the prerequisites finish in", () => {
		for (const order of permutations(["a", "b", "c"])) {
			const { ready } = trashInOrder(fanInBoard(), order);
			expect(ready, order.join(" → ")).toEqual([[], [], ["d"]]);
		}
	});

	it("counts the prerequisites done and still waited on", () => {
		const board = trashInOrder(fanInBoard(), ["b"]).board;

		expect(getTaskPrerequisiteStatus(board, "d")).toEqual({
			total: 3,
			done: 1,
			waitingOnTaskIds: ["a", "c"],
			missingTaskIds: [],
		});
		expect(getTaskPrerequisiteStatus(board, "a")).toBeNull();
	});

	it("counts a prerequisite again once it is restored from Done", () => {
		const board = trashInOrder(fanInBoard(), ["a", "b"]).board;
		const restored = moveTaskToColumn(board, "a", "review").board;

		expect(getTaskPrerequisiteStatus(restored, "d")).toMatchObject({ total: 3, done: 1 });
		expect(trashTaskAndGetReadyLinkedTaskIds(restored, "c").readyTaskIds).toEqual([]);
	});

	it("starts dependents only on a Review → Done move, as before", () => {
		const board = createBoard({ backlog: [createCard({ id: "d" })], in_progress: [createCard({ id: "a" })] }, [
			link("l-a", "d", "a"),
		]);
		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, "a");

		expect(trashed.readyTaskIds).toEqual([]);
		// A discarded prerequisite is in Done, so it counts; the card waits for a person to start it.
		expect(getTaskPrerequisiteStatus(trashed.board, "d")).toMatchObject({ total: 1, done: 1 });
	});

	it("keeps a single-prerequisite card starting on its prerequisite's Done", () => {
		const board = createBoard({ backlog: [createCard({ id: "d" })], review: [createCard({ id: "a" })] }, [
			link("l-a", "d", "a"),
		]);

		expect(trashTaskAndGetReadyLinkedTaskIds(board, "a").readyTaskIds).toEqual(["d"]);
	});

	it("starts every card the last Done completes, each against its own prerequisites", () => {
		const board = createBoard(
			{
				backlog: [createCard({ id: "d" }), createCard({ id: "e" })],
				review: [createCard({ id: "a" }), createCard({ id: "b" })],
			},
			[link("l-da", "d", "a"), link("l-db", "d", "b"), link("l-ea", "e", "a")],
		);

		expect(trashInOrder(board, ["a", "b"]).ready).toEqual([["e"], ["d"]]);
	});
});

describe("board links: deleted prerequisites", () => {
	it("counts a prerequisite deleted while Done as done (prune-done, clearing Done)", () => {
		const afterTwo = trashInOrder(fanInBoard(), ["a", "b"]).board;
		const pruned = deleteTasksFromBoard(afterTwo, ["a", "b"], 7_000).board;

		expect(pruned.dependencies.filter((dependency) => dependency.doneTaskDeletedAt === 7_000)).toHaveLength(2);
		expect(getTaskPrerequisiteStatus(pruned, "d")).toMatchObject({ total: 3, done: 2, waitingOnTaskIds: ["c"] });
		expect(trashTaskAndGetReadyLinkedTaskIds(pruned, "c").readyTaskIds).toEqual(["d"]);
	});

	it("never counts a prerequisite deleted before it was Done, so its card does not start by itself", () => {
		const deleted = deleteTasksFromBoard(fanInBoard(), ["a"], 7_000).board;

		expect(deleted.dependencies.find((dependency) => dependency.id === "l-a")).toEqual(link("l-a", "d", "a"));
		const after = trashInOrder(deleted, ["b", "c"]);
		expect(after.ready).toEqual([[], []]);
		const status = getTaskPrerequisiteStatus(after.board, "d");
		expect(status).toEqual({ total: 3, done: 2, waitingOnTaskIds: [], missingTaskIds: ["a"] });
		expect(status && arePrerequisitesDone(status)).toBe(false);
	});

	it("treats a prerequisite that was never on the board like one deleted before Done", () => {
		const board = createBoard({ backlog: [createCard({ id: "d" })], review: [createCard({ id: "a" })] }, [
			link("l-a", "d", "a"),
			link("l-ghost", "d", "ghost"),
		]);
		const normalized = updateTaskDependencies(board);

		expect(normalized.dependencies.map((dependency) => dependency.id)).toEqual(["l-a", "l-ghost"]);
		expect(trashTaskAndGetReadyLinkedTaskIds(normalized, "a").readyTaskIds).toEqual([]);
	});

	it("drops a deleted card's own links", () => {
		const deleted = deleteTasksFromBoard(fanInBoard(), ["d"]).board;

		expect(deleted.dependencies).toEqual([]);
	});
});

describe("board links: flip and drop rules", () => {
	it("drops a waiting card's links to Done prerequisites once it leaves Backlog, and flips the rest", () => {
		const board = createBoard(
			{
				backlog: [createCard({ id: "d" }), createCard({ id: "p" })],
				review: [createCard({ id: "a" })],
			},
			[link("l-a", "d", "a"), link("l-p", "d", "p")],
		);
		const afterA = trashTaskAndGetReadyLinkedTaskIds(board, "a").board;
		// Someone starts D by hand while it still waits on P.
		const started = moveTaskToColumn(afterA, "d", "in_progress").board;

		// The link to Done A goes (neither card is in Backlog); the one to Backlog P flips: P now waits on D.
		expect(started.dependencies).toEqual([link("l-p", "p", "d")]);
		// The reverse orientation behaves as today: D's own Done starts P.
		const inReview = moveTaskToColumn(started, "d", "review").board;
		expect(trashTaskAndGetReadyLinkedTaskIds(inReview, "d").readyTaskIds).toEqual(["p"]);
	});

	it("drops the links of a waiting card moved to Done from Backlog", () => {
		const board = trashInOrder(fanInBoard(), ["a"]).board;
		const discarded = moveTaskToColumn(board, "d", "trash").board;

		expect(discarded.dependencies).toEqual([]);
	});

	it("drops a link to a Done card that waited on a Backlog card (the Done card is no prerequisite)", () => {
		const board = createBoard({ backlog: [createCard({ id: "p" })], review: [createCard({ id: "d" })] }, [
			link("l-p", "p", "d"),
		]);
		// P waits on D in Review; D's Done is P's prerequisite, so it stays until P starts.
		const afterD = trashTaskAndGetReadyLinkedTaskIds(board, "d").board;
		expect(afterD.dependencies).toEqual([link("l-p", "p", "d")]);
		expect(moveTaskToColumn(afterD, "p", "in_progress").board.dependencies).toEqual([]);
	});

	it("still refuses a new link to a Done card", () => {
		const board = createBoard({ backlog: [createCard({ id: "d" })], trash: [createCard({ id: "a" })] });

		expect(addTaskDependency(board, "d", "a")).toMatchObject({ added: false, reason: "trash_task" });
	});

	it("leaves a normalized board unchanged, so loading an existing board starts or rewrites nothing", () => {
		const board = trashInOrder(fanInBoard(), ["a"]).board;
		const pruned = deleteTasksFromBoard(board, ["a"], 7_000).board;

		expect(updateTaskDependencies(board)).toBe(board);
		expect(updateTaskDependencies(pruned)).toBe(pruned);
		expect(columnOf(pruned, "d")).toBe("backlog");
	});

	it("drops a deletion mark once the card is back on the board", () => {
		const board = createBoard({ backlog: [createCard({ id: "d" })], review: [createCard({ id: "a" })] }, [
			{ ...link("l-a", "d", "a"), doneTaskDeletedAt: 7_000 },
		]);

		expect(updateTaskDependencies(board).dependencies).toEqual([link("l-a", "d", "a")]);
	});
});
