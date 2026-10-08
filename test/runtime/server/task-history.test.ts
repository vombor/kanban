import { appendFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskHistoryEntry } from "../../../src/core/api-contract";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import {
	type CreateTaskTrashWorkflowDependencies,
	createTaskTrashWorkflow,
	createTrashTaskRequestHandler,
	type TaskTrashTrigger,
} from "../../../src/server/task-trash-workflow";
import { getTaskHistoryLogPath } from "../../../src/state/kanban-home";
import { appendTaskHistory, readTaskHistory } from "../../../src/state/task-history-log";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
} from "../../utilities/workspace-state-store";

const worktreeMocks = vi.hoisted(() => ({ deleteTaskWorktree: vi.fn() }));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: worktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: vi.fn(),
}));

const SCOPE = { workspaceId: "ws-1", workspacePath: "/repo" };
const AT = "1970-01-01T00:00:01.000Z";
const CARD_SESSION: RuntimeCaller = {
	kind: "session",
	via: "process",
	session: { workspaceId: "ws-1", taskId: "qa-card", role: "card", agentId: "claude", cwd: "/worktrees/qa-card" },
};

function createHarness(overrides: Partial<CreateTaskTrashWorkflowDependencies> = {}) {
	const store = createWorkspaceStateStore({
		board: createBoard({
			in_progress: [createCard({ id: "task-running" })],
			review: [
				createCard({ id: "task-1", title: "Fix the thing" }),
				createCard({ id: "qa-1", title: "QA: task-1", role: "qa" }),
			],
		}),
		sessions: {},
		revision: 1,
	});
	const effects = createFakeTaskTrashWorkflowDependencies(store);
	const recordHistory = vi.fn(async (_entry: RuntimeTaskHistoryEntry) => {});
	const warn = vi.fn();
	const workflow = createTaskTrashWorkflow({
		...effects.dependencies,
		recordHistory,
		warn,
		now: () => 1_000,
		...overrides,
	});
	return { store, effects, workflow, recordHistory, warn };
}

/** The real router and workspace API in front of the workflow, with `caller` as the request's caller. */
/** `caller` as a function is evaluated when the router looks it up (the /proc trace happens at call time). */
function createRouterCaller(harness: ReturnType<typeof createHarness>, caller: RuntimeCaller | (() => RuntimeCaller)) {
	const recordTaskHistory = vi.fn(async (_entry: RuntimeTaskHistoryEntry) => {});
	const terminalManager = {
		hasLiveProcess: vi.fn((sessionId: string) => sessionId === "task-1"),
		stopTaskSession: vi.fn(),
	};
	const resolveStrictCaller = vi.fn(async () => (typeof caller === "function" ? caller() : caller));
	const context = {
		requestedWorkspaceId: SCOPE.workspaceId,
		workspaceScope: SCOPE,
		resolveStrictCaller,
		workspaceApi: createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			trashTask: createTrashTaskRequestHandler(harness.workflow),
			recordTaskHistory,
			now: () => 2_000,
		}),
	} as unknown as RuntimeTrpcContext;
	return {
		router: runtimeAppRouter.createCaller(context),
		recordTaskHistory,
		terminalManager,
		resolveStrictCaller,
	};
}

describe("task history: Done moves", () => {
	beforeEach(() => {
		worktreeMocks.deleteTaskWorktree.mockReset();
	});

	it.each<TaskTrashTrigger>(["auto_review", "pipeline", "hold_release"])(
		"records an in-process %s Done with no caller",
		async (trigger) => {
			const { workflow, recordHistory } = createHarness();

			await workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger, landing: "land" });

			expect(recordHistory).toHaveBeenCalledTimes(1);
			expect(recordHistory).toHaveBeenCalledWith({
				at: AT,
				action: "done",
				workspaceId: "ws-1",
				taskId: "task-1",
				title: "Fix the thing",
				role: "dev",
				fromColumnId: "review",
				trigger,
				caller: null,
				status: "trashed",
				landing: { choice: "land", outcome: null },
				sessionsStopped: ["task-1", "__detail_terminal__:task-1"],
				worktreeDeleted: true,
			});
		},
	);

	it.each<"cli" | "browser" | "approve">(["cli", "browser", "approve"])(
		"records a tRPC %s Done with the caller project isolation identified",
		async (trigger) => {
			const harness = createHarness();
			const { router, resolveStrictCaller } = createRouterCaller(harness, CARD_SESSION);

			await router.workspace.trashTask({ taskId: "qa-1", trigger });

			expect(resolveStrictCaller).toHaveBeenCalledTimes(1);
			expect(harness.recordHistory).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "qa-1",
					role: "qa",
					fromColumnId: "review",
					trigger,
					caller: {
						kind: "session",
						workspaceId: "ws-1",
						taskId: "qa-card",
						role: "card",
						agentId: "claude",
						via: "process",
					},
					status: "trashed",
					landing: null,
				}),
			);
		},
	);

	it("looks the caller up before the sessions stop, so a card finishing its own card is still identified", async () => {
		const harness = createHarness();
		// The card's CLI runs inside the session the Done stops; traced afterwards it has no process left.
		let sessionStopped = false;
		harness.effects.stopTaskSession.mockImplementation(async () => {
			sessionStopped = true;
		});
		const { router } = createRouterCaller(harness, () =>
			sessionStopped ? { kind: "unknown", reason: "the calling process could not be traced" } : CARD_SESSION,
		);

		await router.workspace.trashTask({ taskId: "qa-1", trigger: "cli" });

		expect(sessionStopped).toBe(true);
		expect(harness.recordHistory).toHaveBeenCalledWith(
			expect.objectContaining({ caller: expect.objectContaining({ kind: "session", taskId: "qa-card" }) }),
		);
	});

	it("records a failed caller lookup as unknown", async () => {
		const { workflow, recordHistory } = createHarness();

		await workflow.trashTask({
			...SCOPE,
			taskId: "task-1",
			trigger: "cli",
			resolveCaller: async () => {
				throw new Error("no /proc");
			},
		});

		expect(recordHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "trashed",
				caller: { kind: "unknown", reason: "the caller lookup failed: no /proc" },
			}),
		);
	});

	it("defaults a tRPC Done without a trigger to cli and records the user", async () => {
		const harness = createHarness();
		const { router } = createRouterCaller(harness, { kind: "user" });

		await router.workspace.trashTask({ taskId: "task-1" });

		expect(harness.recordHistory).toHaveBeenCalledWith(
			expect.objectContaining({ trigger: "cli", caller: { kind: "user" } }),
		);
	});

	it("records a refused Done with its landing choice and outcome", async () => {
		const { workflow, recordHistory } = createHarness({
			doneGate: async () => ({
				proceed: false,
				reason: "land conflict",
				landing: { decision: "conflict", files: ["a.ts"] },
			}),
		});

		const result = await workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger: "pipeline", landing: "land" });

		expect(result.status).toBe("blocked");
		expect(recordHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				fromColumnId: "review",
				role: "dev",
				status: "blocked",
				landing: { choice: "land", outcome: { decision: "conflict", files: ["a.ts"] } },
				sessionsStopped: [],
				worktreeDeleted: false,
				error: "land conflict",
			}),
		);
	});

	it("records an already-done card and a worktree that could not be deleted", async () => {
		const { workflow, recordHistory, effects } = createHarness();
		effects.deleteTaskWorktree.mockResolvedValueOnce({ ok: false, removed: false, error: "busy" } as never);

		await workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger: "cli" });
		await workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger: "cli" });

		expect(recordHistory.mock.calls.map(([entry]) => entry)).toEqual([
			expect.objectContaining({ status: "trashed", worktreeDeleted: false, worktreeDeleteError: "busy" }),
			expect.objectContaining({ status: "already_done", fromColumnId: "trash", sessionsStopped: [] }),
		]);
	});

	it("records a run that threw and still throws", async () => {
		const { workflow, recordHistory } = createHarness({
			mutateWorkspaceState: async () => {
				throw new Error("disk full");
			},
		});

		await expect(workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger: "browser" })).rejects.toThrow("disk full");
		expect(recordHistory).toHaveBeenCalledWith(
			expect.objectContaining({ status: "failed", error: "disk full", fromColumnId: null, role: null }),
		);
	});

	it("only warns when the history can't be written", async () => {
		const { workflow, warn } = createHarness({
			recordHistory: async () => {
				throw new Error("read-only");
			},
		});

		const result = await workflow.trashTask({ ...SCOPE, taskId: "task-1", trigger: "cli" });

		expect(result.status).toBe("trashed");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("read-only"));
	});
});

describe("task history: deletes", () => {
	beforeEach(() => {
		worktreeMocks.deleteTaskWorktree.mockReset();
	});

	it("stops the live sessions, deletes the worktree and records the delete with its caller", async () => {
		worktreeMocks.deleteTaskWorktree.mockResolvedValue({ ok: true, removed: true });
		const { router, recordTaskHistory, terminalManager } = createRouterCaller(createHarness(), { kind: "user" });

		const result = await router.workspace.deleteWorktree({
			taskId: "task-1",
			trigger: "cli",
			fromColumnId: "review",
			role: "dev",
			title: "Fix the thing",
		});

		expect(result).toEqual({ ok: true, removed: true });
		expect(terminalManager.stopTaskSession).toHaveBeenCalledWith("task-1");
		expect(terminalManager.stopTaskSession).toHaveBeenCalledTimes(1);
		expect(recordTaskHistory).toHaveBeenCalledWith({
			at: "1970-01-01T00:00:02.000Z",
			action: "delete",
			workspaceId: "ws-1",
			taskId: "task-1",
			title: "Fix the thing",
			role: "dev",
			fromColumnId: "review",
			trigger: "cli",
			caller: { kind: "user" },
			status: "deleted",
			landing: null,
			sessionsStopped: ["task-1"],
			worktreeDeleted: true,
		});
	});

	it("looks the caller up before it stops the card's session", async () => {
		worktreeMocks.deleteTaskWorktree.mockResolvedValue({ ok: true, removed: true });
		let sessionStopped = false;
		const { router, recordTaskHistory, terminalManager } = createRouterCaller(createHarness(), () =>
			sessionStopped ? { kind: "unknown", reason: "the calling process could not be traced" } : CARD_SESSION,
		);
		terminalManager.stopTaskSession.mockImplementation(() => {
			sessionStopped = true;
		});

		await router.workspace.deleteWorktree({ taskId: "task-1", trigger: "cli" });

		expect(sessionStopped).toBe(true);
		expect(recordTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionsStopped: ["task-1"],
				caller: expect.objectContaining({ kind: "session", taskId: "qa-card" }),
			}),
		);
	});

	it.each(["__home_agent__:ws-1:claude", "__detail_terminal__:task-1"])(
		"refuses to delete the synthetic session %s",
		async (taskId) => {
			const { router, recordTaskHistory, terminalManager } = createRouterCaller(createHarness(), { kind: "user" });

			await expect(router.workspace.deleteWorktree({ taskId })).rejects.toThrow(/not a card's task id/u);
			expect(terminalManager.stopTaskSession).not.toHaveBeenCalled();
			expect(worktreeMocks.deleteTaskWorktree).not.toHaveBeenCalled();
			expect(recordTaskHistory).not.toHaveBeenCalled();
		},
	);

	it("records the browser's Clear Done and a worktree delete that failed", async () => {
		worktreeMocks.deleteTaskWorktree.mockRejectedValue(new Error("EBUSY"));
		const { router, recordTaskHistory } = createRouterCaller(createHarness(), CARD_SESSION);

		const result = await router.workspace.deleteWorktree({
			taskId: "old-1",
			trigger: "browser",
			fromColumnId: "done",
		});

		expect(result).toEqual({ ok: false, removed: false, error: "EBUSY" });
		expect(recordTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "old-1",
				trigger: "browser",
				fromColumnId: "trash",
				role: null,
				caller: expect.objectContaining({ kind: "session", taskId: "qa-card" }),
				status: "failed",
				sessionsStopped: [],
				worktreeDeleted: false,
				worktreeDeleteError: "EBUSY",
			}),
		);
	});
});

describe("task history log", () => {
	it("appends per workspace and reads one task's entries, the newest n, skipping bad lines", async () => {
		await withTemporaryKanbanHome(async () => {
			const entry = (taskId: string, at: string): RuntimeTaskHistoryEntry => ({
				at,
				action: "done",
				workspaceId: "ws-1",
				taskId,
				title: null,
				role: "qa",
				fromColumnId: "review",
				trigger: "pipeline",
				caller: null,
				status: "trashed",
				landing: null,
				sessionsStopped: [],
				worktreeDeleted: true,
			});
			await appendTaskHistory(entry("a5e91", "2026-10-07T23:02:56.000Z"));
			appendFileSync(getTaskHistoryLogPath("ws-1"), "not json\n{}\n");
			await appendTaskHistory(entry("257a4", "2026-10-07T23:02:57.000Z"));
			await appendTaskHistory({ ...entry("a5e91", "2026-10-07T23:02:58.000Z"), workspaceId: "ws-2" });

			const all = await readTaskHistory("ws-1");
			expect(all.path).toBe(getTaskHistoryLogPath("ws-1"));
			expect(all.entries.map((item) => item.taskId)).toEqual(["a5e91", "257a4"]);
			expect((await readTaskHistory("ws-1", { taskId: "257a4" })).entries).toHaveLength(1);
			expect((await readTaskHistory("ws-1", { limit: 1 })).entries.map((item) => item.taskId)).toEqual(["257a4"]);
			expect((await readTaskHistory("ws-3")).entries).toEqual([]);
		});
	});

	it("is served by workspace.getTaskHistory", async () => {
		await withTemporaryKanbanHome(async () => {
			const { router } = createRouterCaller(createHarness(), { kind: "user" });
			const done: RuntimeTaskHistoryEntry = {
				at: AT,
				action: "delete",
				workspaceId: "ws-1",
				taskId: "task-1",
				title: null,
				role: null,
				fromColumnId: null,
				trigger: "watchdog",
				caller: null,
				status: "deleted",
				landing: null,
				sessionsStopped: [],
				worktreeDeleted: false,
			};
			await appendTaskHistory(done);

			expect(await router.workspace.getTaskHistory({ taskId: "task-1" })).toEqual({
				path: getTaskHistoryLogPath("ws-1"),
				entries: [done],
			});
		});
	});
});
