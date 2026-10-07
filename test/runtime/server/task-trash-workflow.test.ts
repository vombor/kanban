import { describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { trashTaskAndGetReadyLinkedTaskIds } from "../../../src/core/task-board-mutations";
import {
	type CreateTaskTrashWorkflowDependencies,
	createTaskTrashWorkflow,
	type TaskTrashRequest,
} from "../../../src/server/task-trash-workflow";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
} from "../../utilities/workspace-state-store";

const SCOPE = { workspaceId: "ws-1", workspacePath: "/repo" };
const SCOPE_MATCHER = expect.objectContaining(SCOPE);

function createHarness(board: RuntimeBoardData, overrides: Partial<CreateTaskTrashWorkflowDependencies> = {}) {
	const store = createWorkspaceStateStore({ board, sessions: {}, revision: 1 });
	const effects = createFakeTaskTrashWorkflowDependencies(store);
	const workflow = createTaskTrashWorkflow({ ...effects.dependencies, now: () => 1_000, ...overrides });
	const trash = (request: Partial<TaskTrashRequest> & { taskId: string }) =>
		workflow.trashTask({ ...SCOPE, trigger: "cli", ...request });
	return { store, effects, workflow, trash };
}

function linkedBoard(reviewCardOverrides: Parameters<typeof createCard>[0] = { id: "task-1" }) {
	return createBoard(
		{
			backlog: [createCard({ id: "task-other" }), createCard({ id: "task-linked" })],
			in_progress: [createCard({ id: "task-running" })],
			review: [createCard(reviewCardOverrides)],
		},
		[{ id: "dep-1", fromTaskId: "task-linked", toTaskId: "task-1", createdAt: 0 }],
	);
}

describe("task trash workflow", () => {
	it("moves a review card to Done, stops its sessions, starts its linked backlog task and removes the worktree", async () => {
		const { store, effects, trash } = createHarness(
			linkedBoard({
				id: "task-1",
				pendingGitAction: { action: "commit", requestedAt: 0, headCommitAtRequest: null, attempt: 0 },
			}),
		);
		const order: string[] = [];
		effects.onBoardMutated.mockImplementation(() => {
			order.push("broadcast");
		});
		effects.stopTaskSession.mockImplementation(async (_scope, taskId) => {
			order.push(`stop:${taskId}`);
		});
		effects.deleteTaskWorktree.mockImplementation(async () => {
			order.push("delete-worktree");
			return { ok: true, removed: true };
		});
		effects.startTaskSession.mockImplementation(async (_scope, input) => {
			order.push(`start:${input.taskId}`);
			return { ok: true, summary: { taskId: input.taskId } as never };
		});

		const result = await trash({ taskId: "task-1" });

		expect(result).toMatchObject({
			ok: true,
			status: "trashed",
			previousColumnId: "review",
			readyTaskIds: ["task-linked"],
			autoStartedTasks: [{ taskId: "task-linked", ok: true }],
			worktreeDeleted: true,
		});
		const trashed = findCardInBoard(store.stored.board, "task-1");
		expect(trashed?.columnId).toBe("trash");
		expect(trashed?.card.pendingGitAction ?? null).toBeNull();
		// The started card goes to the top of In Progress, like the browser's start animation.
		const inProgress = store.stored.board.columns.find((column) => column.id === "in_progress");
		expect(inProgress?.cards.map((card) => card.id)).toEqual(["task-linked", "task-running"]);
		expect(findCardInBoard(store.stored.board, "task-other")?.columnId).toBe("backlog");
		// Browsers see the Done move before the session stop lands.
		expect(order).toEqual([
			"broadcast",
			"stop:task-1",
			"stop:__detail_terminal__:task-1",
			// The linked card is claimed (moved to In Progress) and shown before it starts.
			"broadcast",
			"start:task-linked",
			"delete-worktree",
		]);
		expect(effects.ensureTaskWorktree).toHaveBeenCalledWith(SCOPE_MATCHER, {
			taskId: "task-linked",
			baseRef: "main",
		});
	});

	it("captures the session trees before the sessions stop and reaps the card's processes before the worktree is deleted", async () => {
		const order: string[] = [];
		const { effects, trash } = createHarness(linkedBoard(), {
			prepareProcessReap: async (_scope, taskId) => {
				order.push(`prepare-reap:${taskId}`);
				return {
					reap: async () => {
						order.push(`reap:${taskId}`);
					},
				};
			},
		});
		effects.stopTaskSession.mockImplementation(async (_scope, taskId) => {
			order.push(`stop:${taskId}`);
		});
		effects.startTaskSession.mockImplementation(async (_scope, input) => {
			order.push(`start:${input.taskId}`);
			return { ok: true, summary: { taskId: input.taskId } as never };
		});
		effects.deleteTaskWorktree.mockImplementation(async () => {
			order.push("delete-worktree");
			return { ok: true, removed: true };
		});

		await trash({ taskId: "task-1" });

		expect(order).toEqual([
			"prepare-reap:task-1",
			"stop:task-1",
			"stop:__detail_terminal__:task-1",
			"start:task-linked",
			"reap:task-1",
			"delete-worktree",
		]);
	});

	it("still deletes the worktree when reaping fails", async () => {
		const warn = vi.fn();
		const { effects, trash } = createHarness(linkedBoard(), {
			warn,
			prepareProcessReap: async () => ({
				reap: async () => {
					throw new Error("proc unreadable");
				},
			}),
		});

		const result = await trash({ taskId: "task-1" });

		expect(result).toMatchObject({ ok: true, status: "trashed", worktreeDeleted: true });
		expect(effects.deleteTaskWorktree).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("Could not reap processes of task task-1: proc unreadable");
	});

	it("is a no-op for a card that is already done", async () => {
		const { store, effects, trash } = createHarness(createBoard({ trash: [createCard({ id: "task-1" })] }));

		const result = await trash({ taskId: "task-1" });

		expect(result).toMatchObject({ ok: true, status: "already_done", autoStartedTasks: [] });
		expect(store.stored.revision).toBe(1);
		expect(effects.stopTaskSession).not.toHaveBeenCalled();
		expect(effects.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	it("starts the linked backlog task on the browser path (the browser never persists its own Done move)", async () => {
		const { store, effects, trash } = createHarness(linkedBoard());
		effects.ensureTaskWorktree.mockResolvedValueOnce({
			ok: true,
			path: "/worktrees/task-linked",
			baseRef: "main",
			baseCommit: "base-commit",
			warning: "Saved patch could not be reapplied.",
		});

		const result = await trash({ taskId: "task-1", trigger: "browser" });

		expect(result).toMatchObject({
			status: "trashed",
			previousColumnId: "review",
			readyTaskIds: ["task-linked"],
			autoStartedTasks: [{ taskId: "task-linked", ok: true, warning: "Saved patch could not be reapplied." }],
		});
		expect(findCardInBoard(store.stored.board, "task-linked")?.columnId).toBe("in_progress");
	});

	it("does nothing for a card whose Done move another writer already saved", async () => {
		const board = linkedBoard();
		const { store, effects, trash } = createHarness(board);
		// A real Done move (as an old browser build would persist it) drops the
		// card's dependencies, so there is nothing left to resolve dependents from.
		await store.mutateWorkspaceState("/repo", (state) => ({
			board: trashTaskAndGetReadyLinkedTaskIds(state.board, "task-1").board,
			value: null,
		}));

		const result = await trash({ taskId: "task-1", trigger: "browser" });

		expect(result).toMatchObject({ status: "already_done", autoStartedTasks: [] });
		expect(effects.stopTaskSession).not.toHaveBeenCalled();
		expect(findCardInBoard(store.stored.board, "task-linked")?.columnId).toBe("backlog");
	});

	it("trims the prompt it starts a linked task with", async () => {
		const board = linkedBoard();
		const backlog = board.columns.find((column) => column.id === "backlog");
		const linked = backlog?.cards.find((card) => card.id === "task-linked");
		if (linked) {
			linked.prompt = "  Do the linked work \n";
		}
		const { effects, trash } = createHarness(board);

		await trash({ taskId: "task-1" });

		expect(effects.startTaskSession).toHaveBeenCalledWith(
			SCOPE_MATCHER,
			expect.objectContaining({ taskId: "task-linked", prompt: "Do the linked work" }),
		);
	});

	it("only stops the detail terminal for a backlog card and starts no dependents", async () => {
		const board = createBoard({ backlog: [createCard({ id: "task-1" }), createCard({ id: "task-linked" })] }, [
			{ id: "dep-1", fromTaskId: "task-linked", toTaskId: "task-1", createdAt: 0 },
		]);
		const { effects, trash } = createHarness(board);

		const result = await trash({ taskId: "task-1" });

		expect(result).toMatchObject({ status: "trashed", previousColumnId: "backlog", readyTaskIds: [] });
		expect(effects.stopTaskSession.mock.calls.map(([, taskId]) => taskId)).toEqual(["__detail_terminal__:task-1"]);
		expect(effects.startTaskSession).not.toHaveBeenCalled();
	});

	it("reports a missing card", async () => {
		const { trash } = createHarness(createBoard({}));

		const result = await trash({ taskId: "missing" });

		expect(result).toMatchObject({ ok: false, status: "not_found" });
		expect(result.error).toContain("missing");
	});

	it("leaves the card alone when the guard rejects it inside the board mutation", async () => {
		const { store, effects, trash } = createHarness(linkedBoard());

		const result = await trash({ taskId: "task-1", trigger: "auto_review", canTrash: () => false });

		expect(result).toMatchObject({ ok: false, status: "skipped", previousColumnId: "review" });
		expect(store.stored.revision).toBe(1);
		expect(effects.stopTaskSession).not.toHaveBeenCalled();
	});

	it("lets a done gate keep the card out of Done (hook for the qa landing step)", async () => {
		const doneGate = vi.fn(async () => ({ proceed: false as const, reason: "land conflict" }));
		const { store, effects, trash } = createHarness(linkedBoard(), { doneGate });

		const result = await trash({ taskId: "task-1", trigger: "auto_review" });

		expect(doneGate).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "ws-1",
				fromColumnId: "review",
				trigger: "auto_review",

				card: expect.objectContaining({ id: "task-1" }),
			}),
		);
		expect(result).toMatchObject({ ok: false, status: "blocked", error: "land conflict" });
		expect(findCardInBoard(store.stored.board, "task-1")?.columnId).toBe("review");
		expect(effects.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	it("proceeds when the done gate allows it", async () => {
		const doneGate = vi.fn(async () => ({ proceed: true as const }));
		const { store, trash } = createHarness(linkedBoard(), { doneGate });

		const result = await trash({ taskId: "task-1" });

		expect(result.status).toBe("trashed");
		expect(findCardInBoard(store.stored.board, "task-1")?.columnId).toBe("trash");
	});

	it("shares one run between concurrent requests for the same card", async () => {
		const { effects, workflow } = createHarness(linkedBoard());

		const [first, second] = await Promise.all([
			workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger: "auto_review" }),
			workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger: "browser" }),
		]);

		expect(first).toBe(second);
		expect(effects.deleteTaskWorktree).toHaveBeenCalledTimes(1);
		expect(effects.startTaskSession).toHaveBeenCalledTimes(1);
	});

	it("keeps a linked task in backlog when its session cannot start", async () => {
		const warn = vi.fn();
		const { store, effects, trash } = createHarness(linkedBoard(), { warn });
		effects.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "no agent" } as never);

		const result = await trash({ taskId: "task-1" });

		expect(result.status).toBe("trashed");
		expect(result.autoStartedTasks).toEqual([{ taskId: "task-linked", ok: false, error: "no agent" }]);
		expect(findCardInBoard(store.stored.board, "task-linked")?.columnId).toBe("backlog");
		expect(warn).toHaveBeenCalled();
	});

	it("puts a linked task back where it was in backlog, with its links, when its session cannot start", async () => {
		const board = createBoard(
			{
				backlog: [createCard({ id: "task-other" }), createCard({ id: "task-linked" })],
				review: [createCard({ id: "task-1" }), createCard({ id: "task-2" })],
			},
			[
				{ id: "dep-1", fromTaskId: "task-linked", toTaskId: "task-1", createdAt: 0 },
				{ id: "dep-2", fromTaskId: "task-linked", toTaskId: "task-2", createdAt: 0 },
			],
		);
		const { store, effects, trash } = createHarness(board);
		effects.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "no agent" } as never);

		await trash({ taskId: "task-1" });

		const backlog = store.stored.board.columns.find((column) => column.id === "backlog");
		expect(backlog?.cards.map((card) => card.id)).toEqual(["task-other", "task-linked"]);
		// The link to the card still in Review survives, so finishing it later starts the task.
		expect(store.stored.board.dependencies.map((dependency) => dependency.id)).toEqual(["dep-2"]);
	});

	it("launches a linked task once when two of its blockers finish while it is still starting", async () => {
		// Backlog card C is linked to Review cards A and B. A goes to Done, and B
		// follows while C's worktree is still being set up.
		const board = createBoard(
			{
				backlog: [createCard({ id: "task-c" })],
				review: [createCard({ id: "task-a" }), createCard({ id: "task-b" })],
			},
			[
				{ id: "dep-a", fromTaskId: "task-c", toTaskId: "task-a", createdAt: 0 },
				{ id: "dep-b", fromTaskId: "task-c", toTaskId: "task-b", createdAt: 0 },
			],
		);
		const { store, effects, workflow } = createHarness(board);
		let finishWorktreeSetup: () => void = () => {};
		const worktreeSetupStarted = new Promise<void>((resolveStarted) => {
			effects.ensureTaskWorktree.mockImplementationOnce(async (_scope, input) => {
				resolveStarted();
				await new Promise<void>((resolveSetup) => {
					finishWorktreeSetup = resolveSetup;
				});
				return { ok: true, path: `/worktrees/${input.taskId}`, baseRef: input.baseRef, baseCommit: "base-commit" };
			});
		});

		const first = workflow.trashTask({ ...SCOPE, taskId: "task-a", trigger: "browser" });
		await worktreeSetupStarted;
		expect(findCardInBoard(store.stored.board, "task-c")?.columnId).toBe("in_progress");
		const second = await workflow.trashTask({ ...SCOPE, taskId: "task-b", trigger: "browser" });
		finishWorktreeSetup();
		const firstResult = await first;

		expect(second.status).toBe("trashed");
		expect(second.autoStartedTasks).toEqual([]);
		expect(firstResult.autoStartedTasks).toEqual([{ taskId: "task-c", ok: true }]);
		expect(effects.ensureTaskWorktree).toHaveBeenCalledTimes(1);
		expect(effects.startTaskSession).toHaveBeenCalledTimes(1);
		expect(findCardInBoard(store.stored.board, "task-c")?.columnId).toBe("in_progress");
	});

	it("reports a worktree cleanup failure without failing the move", async () => {
		const { effects, trash } = createHarness(linkedBoard());
		effects.deleteTaskWorktree.mockResolvedValueOnce({ ok: false, removed: false, error: "busy" } as never);

		const result = await trash({ taskId: "task-1" });

		expect(result).toMatchObject({ status: "trashed", worktreeDeleted: false, worktreeDeleteError: "busy" });
	});
});
