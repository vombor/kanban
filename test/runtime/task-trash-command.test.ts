import { beforeEach, describe, expect, it, vi } from "vitest";
import { trashTask } from "../../src/commands/task";
import type { RuntimeWorkspaceStateResponse } from "../../src/core/api-contract";
import { createTaskTrashWorkflow, createTrashTaskRequestHandler } from "../../src/server/task-trash-workflow";
import type * as WorkspaceStateModule from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createWorkspaceApi } from "../../src/trpc/workspace-api";
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

function installRuntime(store: WorkspaceStateStore) {
	const effects = createFakeTaskTrashWorkflowDependencies(store);
	const workflow = createTaskTrashWorkflow(effects.dependencies);
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
});
