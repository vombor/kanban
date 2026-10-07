import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { useLinkedBacklogTaskActions } from "@/hooks/use-linked-backlog-task-actions";
import type { RuntimeTaskTrashResponse } from "@/runtime/types";
import type { UseWorkspacePersistenceResult } from "@/runtime/use-workspace-persistence";
import type { BoardCard, BoardData, BoardDependency } from "@/types";

const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));

function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(dependencies: BoardDependency[] = []): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [createTask("task-1", "Backlog task", 1), createTask("task-3", "Second backlog task", 3)],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [createTask("task-2", "Review task", 2)],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies,
	};
}

interface HookSnapshot {
	board: BoardData;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: "backlog" | "in_progress" | "review" | "trash",
	) => Promise<void>;
}

type TrashTaskMock = Mock<(taskId: string) => Promise<RuntimeTaskTrashResponse | null>>;

function createTrashResponse(overrides: Partial<RuntimeTaskTrashResponse> = {}): RuntimeTaskTrashResponse {
	return {
		ok: true,
		status: "trashed",
		taskId: "task-2",
		previousColumnId: "review",
		readyTaskIds: [],
		autoStartedTasks: [],
		worktreeDeleted: true,
		...overrides,
	};
}

function createWorkspacePersistenceMock() {
	return {
		flushWorkspaceState: vi.fn(async () => {}),
		holdPendingDoneMove: vi.fn(),
		releasePendingDoneMove: vi.fn(),
		awaitPendingDoneMoveSettled: vi.fn(),
	} satisfies UseWorkspacePersistenceResult;
}

function HookHarness({
	boardFactory,
	onSnapshot,
	trashTask,
	workspacePersistence,
	maybeRequestNotificationPermissionForTaskStart,
}: {
	boardFactory?: () => BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	trashTask: TrashTaskMock;
	workspacePersistence?: UseWorkspacePersistenceResult;
	maybeRequestNotificationPermissionForTaskStart?: () => void;
}): null {
	const [board, setBoard] = useState<BoardData>(() => (boardFactory ? boardFactory() : createBoard()));
	const [defaultWorkspacePersistence] = useState(createWorkspacePersistenceMock);
	const actions = useLinkedBacklogTaskActions({
		board,
		setBoard,
		setSelectedTaskId: () => {},
		trashTask,
		workspacePersistence: workspacePersistence ?? defaultWorkspacePersistence,
		maybeRequestNotificationPermissionForTaskStart: maybeRequestNotificationPermissionForTaskStart ?? (() => {}),
	});

	useEffect(() => {
		onSnapshot({
			board,
			handleCreateDependency: actions.handleCreateDependency,
			confirmMoveTaskToTrash: actions.confirmMoveTaskToTrash,
			requestMoveTaskToTrash: actions.requestMoveTaskToTrash,
		});
	}, [
		actions.confirmMoveTaskToTrash,
		actions.handleCreateDependency,
		actions.requestMoveTaskToTrash,
		board,
		onSnapshot,
	]);

	return null;
}

describe("useLinkedBacklogTaskActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		notifyErrorMock.mockReset();
		showAppToastMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderHarness(props: Omit<Parameters<typeof HookHarness>[0], "onSnapshot">) {
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		return {
			current: (): HookSnapshot => {
				if (latestSnapshot === null) {
					throw new Error("Expected a hook snapshot.");
				}
				return latestSnapshot;
			},
		};
	}

	function findReviewTask(snapshot: HookSnapshot): BoardCard {
		const reviewTask = snapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}
		return reviewTask;
	}

	it("adds a dependency for a valid link", async () => {
		const harness = await renderHarness({ trashTask: vi.fn() });

		await act(async () => {
			harness.current().handleCreateDependency("task-1", "task-2");
		});

		const snapshot = harness.current();
		expect(snapshot.board.dependencies).toHaveLength(1);
		expect(snapshot.board.dependencies[0]).toMatchObject({
			fromTaskId: "task-1",
			toTaskId: "task-2",
		});
	});

	it("leaves the Done move to the runtime: held out of saves, pending edits flushed first", async () => {
		const order: string[] = [];
		const workspacePersistence = createWorkspacePersistenceMock();
		workspacePersistence.holdPendingDoneMove.mockImplementation(() => {
			order.push("hold");
		});
		workspacePersistence.flushWorkspaceState.mockImplementation(async () => {
			order.push("flush");
		});
		const trashTask: TrashTaskMock = vi.fn(async () => {
			order.push("trashTask");
			return createTrashResponse();
		});
		const harness = await renderHarness({ trashTask, workspacePersistence });
		const reviewTask = findReviewTask(harness.current());

		await act(async () => {
			await harness.current().confirmMoveTaskToTrash(reviewTask, harness.current().board);
		});

		// The browser no longer stops sessions, removes worktrees or starts
		// dependents itself, and never saves the Done move: the runtime does.
		expect(order).toEqual(["hold", "flush", "trashTask"]);
		expect(trashTask).toHaveBeenCalledWith("task-2");
		expect(workspacePersistence.holdPendingDoneMove).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "task-2", columnId: "review", index: 0, card: reviewTask }),
		);
		expect(workspacePersistence.releasePendingDoneMove).not.toHaveBeenCalled();
		// A lost broadcast must not leave the move held: persistence refetches if it does not settle.
		expect(workspacePersistence.awaitPendingDoneMoveSettled).toHaveBeenCalledWith("task-2");
		// The move is still shown optimistically.
		const done = harness.current().board.columns.find((column) => column.id === "trash")?.cards ?? [];
		expect(done.map((card) => card.id)).toEqual(["task-2"]);
	});

	it("puts the card back when the runtime refuses the Done move", async () => {
		const workspacePersistence = createWorkspacePersistenceMock();
		const trashTask: TrashTaskMock = vi.fn(async () =>
			createTrashResponse({ ok: false, status: "failed", error: "Workspace is gone." }),
		);
		const harness = await renderHarness({
			trashTask,
			workspacePersistence,
			boardFactory: () => createBoard([{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 }]),
		});
		const reviewTask = findReviewTask(harness.current());

		await act(async () => {
			await harness.current().confirmMoveTaskToTrash(reviewTask, harness.current().board);
		});

		expect(workspacePersistence.releasePendingDoneMove).toHaveBeenCalledWith("task-2");
		expect(workspacePersistence.awaitPendingDoneMoveSettled).not.toHaveBeenCalled();
		expect(notifyErrorMock).toHaveBeenCalledWith("Workspace is gone.");
		const board = harness.current().board;
		expect(board.columns.find((column) => column.id === "review")?.cards.map((card) => card.id)).toEqual(["task-2"]);
		expect(board.columns.find((column) => column.id === "trash")?.cards).toHaveLength(0);
		expect(board.dependencies.map((dependency) => dependency.id)).toEqual(["dep-1"]);
	});

	it("requests notification permission when the runtime auto-starts linked tasks", async () => {
		const trashTask: TrashTaskMock = vi.fn(async () =>
			createTrashResponse({
				readyTaskIds: ["task-1", "task-3"],
				autoStartedTasks: [
					{ taskId: "task-1", ok: true },
					{ taskId: "task-3", ok: true },
				],
			}),
		);
		const maybeRequestNotificationPermissionForTaskStart = vi.fn();
		const harness = await renderHarness({
			trashTask,
			maybeRequestNotificationPermissionForTaskStart,
			boardFactory: () =>
				createBoard([
					{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
					{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
				]),
		});
		const reviewTask = findReviewTask(harness.current());

		await act(async () => {
			await harness.current().confirmMoveTaskToTrash(reviewTask, harness.current().board);
		});

		expect(maybeRequestNotificationPermissionForTaskStart).toHaveBeenCalledTimes(1);
	});

	it("reports linked tasks the runtime could not start and worktree setup warnings", async () => {
		const trashTask: TrashTaskMock = vi.fn(async () =>
			createTrashResponse({
				readyTaskIds: ["task-1", "task-3"],
				autoStartedTasks: [
					{ taskId: "task-1", ok: true, warning: "Saved patch could not be reapplied." },
					{ taskId: "task-3", ok: false, error: "No runnable agent command is configured." },
				],
			}),
		);
		const harness = await renderHarness({ trashTask });
		const reviewTask = findReviewTask(harness.current());

		await act(async () => {
			await harness.current().confirmMoveTaskToTrash(reviewTask, harness.current().board);
		});

		expect(notifyErrorMock).toHaveBeenCalledWith("No runnable agent command is configured.");
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "warning", message: "Saved patch could not be reapplied." }),
		);
	});

	it("trashes tasks directly through the request handler", async () => {
		const trashTask: TrashTaskMock = vi.fn(async () => createTrashResponse());
		const harness = await renderHarness({ trashTask });

		await act(async () => {
			await harness.current().requestMoveTaskToTrash("task-2", "review");
		});

		const nextSnapshot = harness.current();
		expect(nextSnapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
		expect(nextSnapshot.board.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe("task-2");
		expect(trashTask).toHaveBeenCalledWith("task-2");
	});
});
