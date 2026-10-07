import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RuntimeAgentId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import type {
	AutoReviewTaskProbe,
	CreateAutoReviewReconcilerDependencies,
	TaskGitPromptTemplates,
} from "../../../src/server/auto-review-reconciler";
import { createAutoReviewReconciler } from "../../../src/server/auto-review-reconciler";
import { createTaskTrashWorkflow } from "../../../src/server/task-trash-workflow";
import type { DeliverTaskInputResult } from "../../../src/terminal/deliver-task-input";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
} from "../../utilities/workspace-state-store";

function createFakeTerminalManager() {
	const unavailableTaskIds = new Set<string>();
	const writeInput = vi.fn((taskId: string, _data: Buffer) => ({ taskId }) as unknown as RuntimeTaskSessionSummary);
	const getSummary = vi.fn((taskId: string) =>
		unavailableTaskIds.has(taskId) ? null : ({ taskId } as unknown as RuntimeTaskSessionSummary),
	);
	return {
		writeInput,
		getSummary,
		dropSession: (taskId: string) => {
			unavailableTaskIds.add(taskId);
		},
		manager: { writeInput, getSummary } as unknown as TerminalSessionManager,
	};
}

interface HarnessOptions {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	selectedAgentId?: RuntimeAgentId;
	promptTemplates?: TaskGitPromptTemplates;
	now?: () => number;
	deliverTaskInput?: CreateAutoReviewReconcilerDependencies["deliverTaskInput"];
}

function createHarness(options: HarnessOptions) {
	const store = createWorkspaceStateStore({
		board: options.board,
		sessions: options.sessions ?? {},
		revision: 1,
	});
	const probeResults = new Map<string, AutoReviewTaskProbe>();
	const probeTaskWorkspace = vi.fn(async ({ taskId }: { taskId: string }) => {
		await Promise.resolve();
		return probeResults.get(taskId) ?? { exists: false, headCommit: null, changedFiles: 0 };
	});
	const terminal = createFakeTerminalManager();
	const onBoardMutated = vi.fn();
	const warn = vi.fn();
	let staleSnapshot: RuntimeWorkspaceStateResponse | null = null;
	// Completion runs through the real Done workflow; only its side effects are faked.
	const trashEffects = createFakeTaskTrashWorkflowDependencies(store);
	const taskTrashWorkflow = createTaskTrashWorkflow({
		...trashEffects.dependencies,
		...(options.now ? { now: options.now } : {}),
	});

	const dependencies: CreateAutoReviewReconcilerDependencies = {
		listWorkspaces: () => [
			{
				workspaceId: "ws-1",
				workspacePath: "/repo",
				terminalManager: terminal.manager,
			},
		],
		getWorkspaceState: async () => staleSnapshot ?? (await store.getWorkspaceState()),
		mutateWorkspaceState: store.mutateWorkspaceState,
		trashTask: taskTrashWorkflow.trashTask,
		getPromptTemplates: async () =>
			options.promptTemplates ?? {
				commitPromptTemplate: "Commit the working changes onto {{base_ref}}.",
				openPrPromptTemplate: "Open a pull request against {{base_ref}}.",
				commitPromptTemplateDefault: null,
				openPrPromptTemplateDefault: null,
			},
		getSelectedAgentId: async () => options.selectedAgentId ?? null,
		probeTaskWorkspace,
		onBoardMutated,
		...(options.now ? { now: options.now } : {}),
		...(options.deliverTaskInput ? { deliverTaskInput: options.deliverTaskInput } : {}),
		warn,
	};

	const reconciler = createAutoReviewReconciler(dependencies);

	return {
		reconciler,
		trashEffects,
		store,
		terminal,
		probeTaskWorkspace,
		onBoardMutated,
		warn,
		setProbe(taskId: string, probe: AutoReviewTaskProbe) {
			probeResults.set(taskId, probe);
		},
		setStaleSnapshot(snapshot: RuntimeWorkspaceStateResponse | null) {
			staleSnapshot = snapshot;
		},
		async evaluate() {
			await reconciler.evaluateWorkspace("ws-1");
		},
	};
}

describe("auto-review reconciler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("advances a review card with no browser client connected", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });

		await harness.evaluate();

		const armed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(armed?.columnId).toBe("review");
		expect(armed?.card.pendingGitAction).toEqual({
			action: "commit",
			requestedAt: expect.any(Number),
			headCommitAtRequest: "commit-1",
			attempt: 0,
		});
		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
		const [promptTaskId, promptData] = harness.terminal.writeInput.mock.calls[0];
		expect(promptTaskId).toBe("task-1");
		expect(promptData?.toString("utf8")).toBe("Commit the working changes onto main.");

		// The submit keystroke follows the prompt after the paste settles.
		await vi.advanceTimersByTimeAsync(250);
		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(2);
		expect(harness.terminal.writeInput.mock.calls[1]?.[1]?.toString("utf8")).toBe("\r");

		// HEAD moves once the agent finishes the commit: the card completes.
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0 });
		await harness.evaluate();

		const completed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(completed?.columnId).toBe("trash");
		expect(completed?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.onBoardMutated).toHaveBeenCalled();
	});

	it("completes an armed card from persisted state after a runtime restart", async () => {
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: Date.now(),
				headCommitAtRequest: "commit-1",
				attempt: 0,
			},
		});
		const harness = createHarness({ board: createBoard({ review: [armedCard] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0 });

		// A fresh reconciler instance sees only the persisted arming state and
		// completes the action once HEAD has moved past the recorded commit.
		await harness.evaluate();

		const completed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(completed?.columnId).toBe("trash");
		expect(completed?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		// One broadcast per completion: the Done workflow sends it, the reconciler does not repeat it.
		expect(harness.trashEffects.onBoardMutated).toHaveBeenCalledTimes(1);
		expect(harness.onBoardMutated).not.toHaveBeenCalled();
	});

	it("completes through the shared Done workflow: session stopped, worktree removed, linked task started", async () => {
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: Date.now(),
				headCommitAtRequest: "commit-1",
				attempt: 0,
			},
		});
		const linkedCard = createCard({ id: "task-linked" });
		const harness = createHarness({
			board: createBoard({ backlog: [linkedCard], review: [armedCard] }, [
				{ id: "dep-1", fromTaskId: "task-linked", toTaskId: "task-1", createdAt: 0 },
			]),
		});
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0 });

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("trash");
		const stoppedIds = harness.trashEffects.stopTaskSession.mock.calls.map(([, taskId]) => taskId);
		expect(stoppedIds).toEqual(expect.arrayContaining(["task-1", "__detail_terminal__:task-1"]));
		expect(harness.trashEffects.deleteTaskWorktree).toHaveBeenCalledWith(expect.anything(), "task-1");
		expect(harness.trashEffects.startTaskSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ taskId: "task-linked", prompt: linkedCard.prompt, baseRef: "main" }),
		);
		expect(findCardInBoard(harness.store.stored.board, "task-linked")?.columnId).toBe("in_progress");
	});

	it("does not sweep interrupted tasks or worktrees on boot", async () => {
		const interruptedCards = [
			createCard({ id: "task-1" }),
			createCard({ id: "task-2" }),
			createCard({ id: "task-3" }),
		];
		const sessions: Record<string, RuntimeTaskSessionSummary> = {};
		for (const card of interruptedCards) {
			sessions[card.id] = { taskId: card.id, state: "interrupted" } as unknown as RuntimeTaskSessionSummary;
		}
		const harness = createHarness({
			board: createBoard({ in_progress: interruptedCards }),
			sessions,
		});
		for (const card of interruptedCards) {
			harness.setProbe(card.id, { exists: true, headCommit: "commit-1", changedFiles: 2 });
		}

		await harness.evaluate();

		const boardAfter = harness.store.stored.board;
		for (const card of interruptedCards) {
			const found = findCardInBoard(boardAfter, card.id);
			expect(found?.columnId).toBe("in_progress");
		}
		expect(harness.store.stored.sessions).toEqual(sessions);
		// Three interrupted tasks in, three worktrees out: nothing was probed,
		// stopped, restarted, trashed, or cleaned up.
		expect(harness.probeTaskWorkspace).not.toHaveBeenCalled();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		expect(harness.store.stored.revision).toBe(1);
	});

	it("performs zero git probes for a workspace with no auto-review candidates", async () => {
		const harness = createHarness({
			board: createBoard({
				backlog: [createCard({ id: "task-backlog" })],
				in_progress: [createCard({ id: "task-running" })],
				// Enabled=false and missing auto-review config are both non-candidates.
				review: [
					createCard({ id: "task-review-disabled", autoReviewEnabled: false }),
					createCard({ id: "task-review-default" }),
				],
			}),
		});
		harness.setProbe("task-running", { exists: true, headCommit: "commit-1", changedFiles: 4 });
		harness.setProbe("task-review-default", { exists: true, headCommit: "commit-1", changedFiles: 4 });

		await harness.evaluate();

		expect(harness.probeTaskWorkspace).not.toHaveBeenCalled();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		expect(harness.store.stored.revision).toBe(1);
	});

	it("delivers git actions for Cline cards through the task terminal", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }), selectedAgentId: "cline" });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });

		await harness.evaluate();

		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();
	});

	it("starts exactly one git action when two evaluations race", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });

		// Both evaluations observed the unarmed board before either persisted the
		// arming state. The compare-and-set mutation must let only one through.
		const staleSnapshot = await harness.store.getWorkspaceState();
		harness.setStaleSnapshot(staleSnapshot);

		await Promise.all([harness.reconciler.evaluateWorkspace("ws-1"), harness.reconciler.evaluateWorkspace("ws-1")]);

		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
		const armed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(armed?.card.pendingGitAction).not.toBeNull();
		expect(armed?.card.pendingGitAction?.attempt).toBe(0);
	});

	describe("prompt delivery", () => {
		function createDeliveryStub(result: Omit<DeliverTaskInputResult, "ok" | "evidence" | "summary">) {
			return vi.fn(
				async (): Promise<DeliverTaskInputResult> => ({
					ok: result.status === "delivered" || result.status === "sent",
					evidence: result.status === "delivered" ? "hook" : null,
					summary: null,
					...result,
				}),
			);
		}

		async function armWith(deliver: ReturnType<typeof createDeliveryStub>) {
			const card = createCard({ id: "task-1", autoReviewEnabled: true, agentId: "copilot" });
			const harness = createHarness({ board: createBoard({ review: [card] }), deliverTaskInput: deliver });
			harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });
			await harness.evaluate();
			// Delivery settles in the background, after the cycle.
			await vi.runAllTimersAsync();
			return harness;
		}

		it("delivers the prompt through deliverTaskInput and stays armed once confirmed", async () => {
			const deliver = createDeliveryStub({ status: "delivered", enterAttempts: 1 });
			const harness = await armWith(deliver);

			expect(deliver).toHaveBeenCalledTimes(1);
			expect(deliver).toHaveBeenCalledWith(
				harness.terminal.manager,
				"task-1",
				"Commit the working changes onto main.",
				expect.objectContaining({ agentId: "copilot", signal: expect.any(AbortSignal) }),
			);
			expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();
			expect(harness.warn).not.toHaveBeenCalled();
		});

		it("stays armed and warns when the prompt was typed but not confirmed", async () => {
			const deliver = createDeliveryStub({
				status: "undelivered",
				enterAttempts: 2,
				error: "Typed input not picked up (no session activity after Enter, twice).",
			});
			const harness = await armWith(deliver);

			// Re-arming would type the prompt into the TUI a second time.
			expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();
			expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("was not confirmed"));

			await harness.evaluate();
			await vi.runAllTimersAsync();
			expect(deliver).toHaveBeenCalledTimes(1);
		});

		it("disarms the card when there is no session to deliver to", async () => {
			const deliver = createDeliveryStub({
				status: "no_session",
				enterAttempts: 0,
				error: "Task session is not running.",
			});
			const harness = await armWith(deliver);

			expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
			expect(harness.onBoardMutated).toHaveBeenCalled();
		});

		it("disarms when the summary is left over but the PTY is gone (real delivery)", async () => {
			const card = createCard({ id: "task-1", autoReviewEnabled: true });
			const harness = createHarness({ board: createBoard({ review: [card] }) });
			harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });
			harness.terminal.writeInput.mockReturnValue(null as unknown as RuntimeTaskSessionSummary);

			await harness.evaluate();
			await vi.runAllTimersAsync();

			expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
			expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
		});
	});

	it("clears a pending git action once it goes stale", async () => {
		let currentTime = 1_000_000;
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: 0,
				headCommitAtRequest: "commit-1",
				attempt: 2,
			},
		});
		const harness = createHarness({
			board: createBoard({ review: [armedCard] }),
			now: () => currentTime,
		});
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0 });

		// Just inside the staleness window the card stays armed.
		currentTime = 14 * 60_000;
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();

		// Past the window the stale arming state is cleared so the card can re-arm.
		currentTime = 16 * 60_000;
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
	});
});
