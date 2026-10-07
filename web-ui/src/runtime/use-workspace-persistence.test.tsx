import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceStateResponse, RuntimeWorkspaceStateSaveRequest } from "@/runtime/types";
import {
	PENDING_DONE_MOVE_SETTLE_TIMEOUT_MS,
	type UseWorkspacePersistenceResult,
	useWorkspacePersistence,
} from "@/runtime/use-workspace-persistence";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import { trashTaskAndGetReadyLinkedTaskIds, updateTaskTitle } from "@/state/board-state";
import { capturePendingDoneMove } from "@/state/pending-done-moves";
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
			{ id: "backlog", title: "Backlog", cards: [createTask("task-linked", 1)] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [createTask("task-done", 2), createTask("task-edit", 3)] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [{ id: "dep-1", fromTaskId: "task-linked", toTaskId: "task-done", createdAt: 4 }],
	};
}

function columnOf(board: BoardData, taskId: string): string | null {
	return board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ?? null;
}

/** Stands in for the runtime's revisioned state store. */
function createRuntimeStore() {
	const store = { revision: 1 };
	const saves: RuntimeWorkspaceStateSaveRequest[] = [];
	const persistWorkspaceState = vi.fn(
		async ({ payload }: { workspaceId: string; payload: RuntimeWorkspaceStateSaveRequest }) => {
			saves.push(payload);
			if (payload.expectedRevision !== store.revision) {
				throw new WorkspaceStateConflictError(store.revision);
			}
			store.revision += 1;
			return { revision: store.revision } as RuntimeWorkspaceStateResponse;
		},
	);
	return { store, saves, persistWorkspaceState };
}

interface HarnessControls {
	persistence: UseWorkspacePersistenceResult;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	/** Applies runtime state the way use-workspace-sync does on a broadcast. */
	hydrate: (board: BoardData, revision: number) => void;
}

function HookHarness({
	persistWorkspaceState,
	refetchWorkspaceState,
	onWorkspaceStateConflict,
	onControls,
}: {
	refetchWorkspaceState: () => Promise<unknown>;
	persistWorkspaceState: ReturnType<typeof createRuntimeStore>["persistWorkspaceState"];
	onWorkspaceStateConflict: () => void;
	onControls: (controls: HarnessControls) => void;
}): null {
	const [board, setBoard] = useState<BoardData>(createBoard);
	const [revision, setRevision] = useState<number | null>(1);
	const [hydrationNonce, setHydrationNonce] = useState(1);
	const persistence = useWorkspacePersistence({
		board,
		sessions: {},
		currentProjectId: "project-1",
		workspaceRevision: revision,
		hydrationNonce,
		canPersistWorkspaceState: true,
		isDocumentVisible: true,
		isWorkspaceStateRefreshing: false,
		persistWorkspaceState,
		refetchWorkspaceState,
		onWorkspaceRevisionChange: setRevision,
		onWorkspaceStateConflict,
	});

	useEffect(() => {
		onControls({
			persistence,
			setBoard,
			hydrate: (nextBoard, nextRevision) => {
				setBoard(nextBoard);
				setRevision(nextRevision);
				setHydrationNonce((current) => current + 1);
			},
		});
	}, [onControls, persistence]);

	return null;
}

describe("useWorkspacePersistence", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
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
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderHarness() {
		const runtime = createRuntimeStore();
		const onWorkspaceStateConflict = vi.fn();
		const refetchWorkspaceState = vi.fn(async () => {});
		let controls: HarnessControls | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					persistWorkspaceState={runtime.persistWorkspaceState}
					refetchWorkspaceState={refetchWorkspaceState}
					onWorkspaceStateConflict={onWorkspaceStateConflict}
					onControls={(next) => {
						controls = next;
					}}
				/>,
			);
		});
		const current = (): HarnessControls => {
			if (!controls) {
				throw new Error("Expected harness controls.");
			}
			return controls;
		};
		// The browser starts from the runtime's board, as use-workspace-sync hydrates it.
		await act(async () => {
			current().hydrate(createBoard(), runtime.store.revision);
		});
		// Mirrors the browser's Done move: hold it, then show it optimistically.
		const moveToDoneOptimistically = (taskId: string) => {
			const { persistence, setBoard } = current();
			let held = false;
			setBoard((board) => {
				const move = capturePendingDoneMove(board, taskId);
				if (move && !held) {
					persistence.holdPendingDoneMove(move);
					held = true;
				}
				return trashTaskAndGetReadyLinkedTaskIds(board, taskId).board;
			});
		};
		const editTitle = (taskId: string, title: string) => {
			current().setBoard((board) => updateTaskTitle(board, taskId, title).board);
		};
		return { runtime, onWorkspaceStateConflict, refetchWorkspaceState, current, moveToDoneOptimistically, editTitle };
	}

	it("never saves the optimistic Done move", async () => {
		const harness = await renderHarness();

		await act(async () => {
			harness.moveToDoneOptimistically("task-done");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(harness.runtime.persistWorkspaceState).not.toHaveBeenCalled();
	});

	it("flushes a pending unrelated edit without the Done move, so the runtime's write cannot conflict", async () => {
		const harness = await renderHarness();

		await act(async () => {
			harness.editTitle("task-edit", "Edited title");
			harness.moveToDoneOptimistically("task-done");
		});
		await act(async () => {
			await harness.current().persistence.flushWorkspaceState();
		});

		expect(harness.runtime.saves).toHaveLength(1);
		const saved = harness.runtime.saves[0]?.board;
		if (!saved) {
			throw new Error("Expected a saved board.");
		}
		expect(columnOf(saved, "task-done")).toBe("review");
		expect(saved.dependencies.map((dependency) => dependency.id)).toEqual(["dep-1"]);
		expect(saved.columns.flatMap((column) => column.cards).find((card) => card.id === "task-edit")?.title).toBe(
			"Edited title",
		);

		// The runtime's Done workflow writes the move next (revision 2 → 3) and
		// broadcasts it. The debounced save that was scheduled for the same
		// local board has nothing left to write, so nothing conflicts.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(harness.runtime.saves).toHaveLength(1);

		harness.runtime.store.revision += 1;
		const runtimeBoard = trashTaskAndGetReadyLinkedTaskIds(saved, "task-done").board;
		await act(async () => {
			harness.current().hydrate(runtimeBoard, harness.runtime.store.revision);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(harness.runtime.saves).toHaveLength(1);
		expect(harness.onWorkspaceStateConflict).not.toHaveBeenCalled();
	});

	it("keeps the held move out of later edits until the runtime's board shows it", async () => {
		const harness = await renderHarness();

		await act(async () => {
			harness.moveToDoneOptimistically("task-done");
		});
		await act(async () => {
			harness.editTitle("task-edit", "Edited while Done is pending");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(harness.runtime.saves).toHaveLength(1);
		expect(columnOf(harness.runtime.saves[0]?.board ?? createBoard(), "task-done")).toBe("review");

		// The runtime's board arrives with the card in Done: from here on the
		// browser's saves carry it in Done (they no longer put it back).
		harness.runtime.store.revision += 1;
		const runtimeBoard = trashTaskAndGetReadyLinkedTaskIds(
			harness.runtime.saves[0]?.board ?? createBoard(),
			"task-done",
		).board;
		await act(async () => {
			harness.current().hydrate(runtimeBoard, harness.runtime.store.revision);
		});
		await act(async () => {
			harness.editTitle("task-edit", "Edited after the broadcast");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		expect(harness.runtime.saves).toHaveLength(2);
		expect(columnOf(harness.runtime.saves[1]?.board ?? createBoard(), "task-done")).toBe("trash");
		expect(harness.onWorkspaceStateConflict).not.toHaveBeenCalled();
	});

	it("refetches when the runtime's broadcast of an accepted Done move never arrives", async () => {
		const harness = await renderHarness();
		await act(async () => {
			harness.moveToDoneOptimistically("task-done");
		});

		await act(async () => {
			harness.current().persistence.awaitPendingDoneMoveSettled("task-done");
			await vi.advanceTimersByTimeAsync(PENDING_DONE_MOVE_SETTLE_TIMEOUT_MS - 1);
		});
		expect(harness.refetchWorkspaceState).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(harness.refetchWorkspaceState).toHaveBeenCalledTimes(1);
	});

	it("does not refetch when the broadcast settles the move in time", async () => {
		const harness = await renderHarness();
		await act(async () => {
			harness.moveToDoneOptimistically("task-done");
		});
		await act(async () => {
			harness.current().persistence.awaitPendingDoneMoveSettled("task-done");
		});

		harness.runtime.store.revision += 1;
		await act(async () => {
			harness
				.current()
				.hydrate(
					trashTaskAndGetReadyLinkedTaskIds(createBoard(), "task-done").board,
					harness.runtime.store.revision,
				);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PENDING_DONE_MOVE_SETTLE_TIMEOUT_MS * 2);
		});

		expect(harness.refetchWorkspaceState).not.toHaveBeenCalled();
	});
});
