import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveTask, releaseHoldTask, trashTask } from "../../src/commands/task";
import type { RuntimeWorkspaceStateResponse } from "../../src/core/api-contract";
import { createPipelineStateStore } from "../../src/pipeline/pipeline-state";
import {
	createTaskTrashWorkflow,
	createTrashTaskRequestHandler,
	type TaskDoneGate,
} from "../../src/server/task-trash-workflow";
import { getWatchdogWorkspacePaths } from "../../src/state/kanban-home";
import type * as WorkspaceStateModule from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createWorkspaceApi } from "../../src/trpc/workspace-api";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
	type WorkspaceStateStore,
} from "../utilities/workspace-state-store";

// `kanban task done` talks to the runtime over tRPC. The fake client below
// routes those calls into the real router, workspace API and Done workflow, so
// the test proves the CLI goes through the shared server-side path.
const harness = vi.hoisted(() => ({
	createClient: null as null | (() => unknown),
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => {
		if (!harness.createClient) {
			throw new Error("tRPC client harness is not set up.");
		}
		return harness.createClient();
	},
	httpBatchLink: () => null,
}));

vi.mock("../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/repo", workspaceId: "ws-1" })),
	};
});

const SCOPE = { workspaceId: "ws-1", workspacePath: "/repo" };

function installRuntime(store: WorkspaceStateStore, doneGate?: TaskDoneGate) {
	const effects = createFakeTaskTrashWorkflowDependencies(store);
	const workflow = createTaskTrashWorkflow({ ...effects.dependencies, doneGate });
	const trashTaskSpy = vi.spyOn(workflow, "trashTask");
	const context = {
		requestedWorkspaceId: SCOPE.workspaceId,
		workspaceScope: SCOPE,
		workspaceApi: createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			trashTask: createTrashTaskRequestHandler(workflow),
		}),
	} as unknown as RuntimeTrpcContext;
	const caller = runtimeAppRouter.createCaller(context);
	harness.createClient = () => ({
		projects: { add: { mutate: async () => ({ ok: true, project: { id: SCOPE.workspaceId } }) } },
		workspace: {
			trashTask: {
				mutate: (input: Parameters<typeof caller.workspace.trashTask>[0]) => caller.workspace.trashTask(input),
			},
			getState: { query: async (): Promise<RuntimeWorkspaceStateResponse> => await store.getWorkspaceState() },
		},
	});
	return { effects, trashTaskSpy };
}

describe("kanban task done", () => {
	beforeEach(() => {
		harness.createClient = null;
	});

	it("moves the card through the server-side Done workflow", async () => {
		const store = createWorkspaceStateStore({
			board: createBoard(
				{
					backlog: [createCard({ id: "task-linked" })],
					review: [createCard({ id: "task-1" })],
				},
				[{ id: "dep-1", fromTaskId: "task-linked", toTaskId: "task-1", createdAt: 0 }],
			),
			sessions: {},
			revision: 1,
		});
		const { effects, trashTaskSpy } = installRuntime(store);

		const output = await trashTask({ cwd: "/repo", taskId: "task-1" });

		expect(trashTaskSpy).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", trigger: "cli" }));
		expect(output).toMatchObject({
			ok: true,
			task: { id: "task-1", column: "trash" },
			readyTaskIds: ["task-linked"],
			autoStartedTasks: [{ ok: true, task: { id: "task-linked", column: "in_progress" } }],
			worktreeDeleted: true,
		});
		expect(findCardInBoard(store.stored.board, "task-1")?.columnId).toBe("trash");
		expect(effects.deleteTaskWorktree).toHaveBeenCalledTimes(1);
	});

	it("reports a card that is already done without cleaning up again", async () => {
		const store = createWorkspaceStateStore({
			board: createBoard({ trash: [createCard({ id: "task-1" })] }),
			sessions: {},
			revision: 1,
		});
		const { effects } = installRuntime(store);

		const output = await trashTask({ cwd: "/repo", taskId: "task-1" });

		expect(output).toMatchObject({ ok: true, message: 'Task "task-1" is already done.' });
		expect(effects.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	it("fails for an unknown card", async () => {
		const store = createWorkspaceStateStore({ board: createBoard({}), sessions: {}, revision: 1 });
		installRuntime(store);

		await expect(trashTask({ cwd: "/repo", taskId: "missing" })).rejects.toThrow(/missing/);
	});

	it("passes --land/--discard and Approve & land to the Done workflow's landing step", async () => {
		const store = createWorkspaceStateStore({
			board: createBoard({ review: [createCard({ id: "task-1" }), createCard({ id: "task-2" })] }),
			sessions: {},
			revision: 1,
		});
		const doneGate = vi.fn<TaskDoneGate>(async (input) =>
			input.landing === "land"
				? { proceed: true, landing: { decision: "landed", baseRef: "main", commit: "abc123" } }
				: { proceed: true, landing: { decision: "discarded", baseRef: "main" } },
		);
		const { trashTaskSpy } = installRuntime(store, doneGate);

		const approved = await approveTask({ cwd: "/repo", taskId: "task-1" });
		const discarded = await trashTask({ cwd: "/repo", taskId: "task-2", landing: "discard" });

		expect(trashTaskSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ trigger: "approve", landing: "land" }));
		expect(trashTaskSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ trigger: "cli", landing: "discard" }));
		expect(approved).toMatchObject({ ok: true, landing: { decision: "landed", commit: "abc123" } });
		expect(discarded).toMatchObject({ ok: true, landing: { decision: "discarded" } });
	});

	it("fails with the land-or-discard question when the landing step needs a choice", async () => {
		const store = createWorkspaceStateStore({
			board: createBoard({ review: [createCard({ id: "task-1" })] }),
			sessions: {},
			revision: 1,
		});
		installRuntime(store, async () => ({
			proceed: false,
			reason: "Task task-1 has work that is not on main. Land or discard it",
			landing: { decision: "required", baseRef: "main" },
		}));

		await expect(trashTask({ cwd: "/repo", taskId: "task-1" })).rejects.toThrow(/Land or discard it/u);
		expect(findCardInBoard(store.stored.board, "task-1")?.columnId).toBe("review");
	});

	it("refuses to land a decided runoff's loser (done --land, approve, release-hold --land); the winner lands", async () => {
		await withTemporaryKanbanHome(async () => {
			const store = createWorkspaceStateStore({
				board: createBoard({
					review: [createCard({ id: "w0001" }), createCard({ id: "l0001" }), createCard({ id: "l0002" })],
				}),
				sessions: {},
				revision: 1,
			});
			const doneGate = vi.fn<TaskDoneGate>(async (input) =>
				input.landing === "land"
					? { proceed: true, landing: { decision: "landed", baseRef: "main", commit: "abc123" } }
					: { proceed: true, landing: { decision: "discarded", baseRef: "main" } },
			);
			const { trashTaskSpy } = installRuntime(store, doneGate);
			const path = getWatchdogWorkspacePaths("ws-1").runoffs;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				JSON.stringify({
					runoffs: [
						{
							name: "tier2-promos",
							cards: ["w0001", "l0001", "l0002"],
							decided: "2026-10-08T01:04:17.000Z",
							winner: "w0001",
						},
					],
				}),
			);
			await createPipelineStateStore().update("ws-1", (state) => {
				state.cards.l0002 = { hold: { group: "tier2-promos", at: "2026-10-08T01:00:00.000Z", round: 1 } };
				return state;
			});

			await expect(trashTask({ cwd: "/repo", taskId: "l0001", landing: "land" })).rejects.toThrow(
				'Task "l0001" raced in runoff tier2-promos, which is decided (winner w0001); it must not land.',
			);
			// Not held: a plain Done discards it. Held: only release-hold does.
			await expect(approveTask({ cwd: "/repo", taskId: "l0001" })).rejects.toThrow(
				"The runoff's decision is final: discard it (kanban task done --task-id l0001 --discard), and to use its work, start a new card from its preserve/l0001-<model> tag.",
			);
			await expect(trashTask({ cwd: "/repo", column: "review", landing: "land" })).rejects.toThrow(
				'Task "l0001" raced in runoff tier2-promos',
			);
			await expect(releaseHoldTask({ cwd: "/repo", taskId: "l0002", landing: "land" })).rejects.toThrow(
				"it must not land. The runoff's decision is final: discard it (kanban task release-hold --task-id l0002 --discard)",
			);
			await expect(trashTask({ cwd: "/repo", taskId: "l0002", landing: "land" })).rejects.toThrow(
				"discard it (kanban task release-hold --task-id l0002 --discard)",
			);
			expect(trashTaskSpy).not.toHaveBeenCalled();
			// The refused release left the hold where it was.
			expect((await createPipelineStateStore().load("ws-1")).cards.l0002?.hold).toMatchObject({
				group: "tier2-promos",
			});

			await expect(trashTask({ cwd: "/repo", taskId: "w0001", landing: "land" })).resolves.toMatchObject({
				ok: true,
				landing: { decision: "landed" },
			});
			await expect(trashTask({ cwd: "/repo", taskId: "l0001", landing: "discard" })).resolves.toMatchObject({
				ok: true,
				landing: { decision: "discarded" },
			});
		});
	});
});
