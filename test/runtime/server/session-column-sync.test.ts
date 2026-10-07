import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClineTurnDetectorMode } from "../../../src/config/cline-turn-detector-config";
import type {
	RuntimeBoardData,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { type AutoReviewTaskProbe, createAutoReviewReconciler } from "../../../src/server/auto-review-reconciler";
import {
	type CreateSessionColumnSyncDependencies,
	createSessionColumnSync,
	planSessionColumnMoves,
	type SessionColumnMove,
	type SessionColumnSyncSessions,
} from "../../../src/server/session-column-sync";
import { createTaskTrashWorkflow, type MutateWorkspaceState } from "../../../src/server/task-trash-workflow";
import type { ClineSessionFileReader } from "../../../src/terminal/cline-session-files";
import type { ClineSessionSnapshot } from "../../../src/terminal/cline-turn-outcome";
import type { DeliverTaskInputResult } from "../../../src/terminal/deliver-task-input";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
} from "../../utilities/workspace-state-store";

const WORKSPACE_ID = "ws-1";
const WORKSPACE_PATH = "/repo";

function createSummary(
	taskId: string,
	state: RuntimeTaskSessionState,
	updatedAt: number,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt,
		lastOutputAt: null,
		reviewReason: state === "awaiting_review" ? "hook" : state === "interrupted" ? "interrupted" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

/** Stands in for a TerminalSessionManager: holds summaries and emits them like `emitSummary`. */
function createFakeSessions(initial: RuntimeTaskSessionSummary[] = [], stateEnteredAt: Map<string, number> = new Map()) {
	const summaries = new Map(initial.map((summary) => [summary.taskId, summary]));
	const listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	const sessions: SessionColumnSyncSessions = {
		onSummary: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		listSummaries: () => [...summaries.values()].map((summary) => ({ ...summary })),
		getStateEnteredAt: (taskId) => stateEnteredAt.get(taskId) ?? null,
	};
	const emit = (summary: RuntimeTaskSessionSummary) => {
		summaries.set(summary.taskId, summary);
		for (const listener of listeners) {
			listener({ ...summary });
		}
	};
	return { sessions, emit, listenerCount: () => listeners.size };
}

function createHarness(
	board: RuntimeBoardData,
	summaries: RuntimeTaskSessionSummary[] = [],
	overrides: Partial<CreateSessionColumnSyncDependencies> = {},
) {
	const store = createWorkspaceStateStore({ board, sessions: {}, revision: 1 });
	let boardReads = 0;
	const mutateWorkspaceState: MutateWorkspaceState = async (workspacePath, mutate) => {
		boardReads += 1;
		return await store.mutateWorkspaceState(workspacePath, mutate);
	};
	const onBoardMutated = vi.fn();
	const moves: SessionColumnMove[] = [];
	let clock = 10_000;
	const sync = createSessionColumnSync({
		listWorkspaces: () => [{ workspaceId: WORKSPACE_ID, workspacePath: WORKSPACE_PATH }],
		mutateWorkspaceState,
		onBoardMutated,
		onMoved: (_workspaceId, applied) => moves.push(...applied),
		now: () => clock,
		...overrides,
	});
	const fake = createFakeSessions(summaries);
	sync.trackWorkspace(WORKSPACE_ID, fake.sessions);
	return {
		store,
		sync,
		fake,
		moves,
		boardReads: () => boardReads,
		onBoardMutated,
		columnOf: (taskId: string) => findCardInBoard(store.stored.board, taskId)?.columnId ?? null,
		columnIds: (columnId: string) =>
			store.stored.board.columns.find((column) => column.id === columnId)?.cards.map((card) => card.id) ?? [],
		setClock: (value: number) => {
			clock = value;
		},
	};
}

/** Lets the sync chains started by summary events settle. */
async function settle(): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("planSessionColumnMoves", () => {
	const board = createBoard({
		in_progress: [createCard({ id: "ip", updatedAt: 100 })],
		review: [createCard({ id: "rv", updatedAt: 100 })],
		backlog: [createCard({ id: "bl", updatedAt: 100 })],
		trash: [createCard({ id: "dn", updatedAt: 100 })],
	});

	it("moves awaiting_review out of In Progress and running out of Review", () => {
		expect(
			planSessionColumnMoves(board, [
				createSummary("ip", "awaiting_review", 200),
				createSummary("rv", "running", 200),
			]),
		).toEqual([
			{ taskId: "ip", from: "in_progress", to: "review", sessionState: "awaiting_review" },
			{ taskId: "rv", from: "review", to: "in_progress", sessionState: "running" },
		]);
	});

	it("only lets a summary newer than the card move it (updatedAt guard)", () => {
		expect(
			planSessionColumnMoves(board, [
				createSummary("ip", "awaiting_review", 100),
				createSummary("rv", "running", 50),
			]),
		).toEqual([]);
	});

	it("leaves a Review card armed by auto-review in Review while its session runs the git prompt", () => {
		const pendingGitAction = { action: "commit" as const, requestedAt: 100, headCommitAtRequest: "c1", attempt: 0 };
		const armedBoard = createBoard({
			review: [
				createCard({ id: "armed", updatedAt: 100, autoReviewEnabled: true, pendingGitAction }),
				createCard({ id: "unarmed", updatedAt: 100, autoReviewEnabled: true }),
				createCard({ id: "toggle-off", updatedAt: 100, autoReviewEnabled: false, pendingGitAction }),
			],
		});
		expect(
			planSessionColumnMoves(armedBoard, [
				createSummary("armed", "running", 200),
				createSummary("unarmed", "running", 200),
				createSummary("toggle-off", "running", 200),
			]).map((move) => move.taskId),
		).toEqual(["unarmed", "toggle-off"]);
	});

	it("never moves an interrupted, idle or failed session's card, and never into or out of Backlog or Done", () => {
		expect(
			planSessionColumnMoves(board, [
				createSummary("ip", "interrupted", 200),
				createSummary("rv", "interrupted", 200),
				createSummary("ip", "failed", 200),
				createSummary("rv", "idle", 200),
				createSummary("bl", "running", 200),
				createSummary("bl", "awaiting_review", 200),
				createSummary("dn", "running", 200),
				createSummary("dn", "awaiting_review", 200),
				createSummary("no-card", "awaiting_review", 200),
			]),
		).toEqual([]);
	});
});

describe("session column sync", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("moves a card whose turn ended to the top of Review and broadcasts the board", async () => {
		const harness = createHarness(
			createBoard({
				in_progress: [createCard({ id: "task-1", updatedAt: 100 })],
				review: [createCard({ id: "task-old", updatedAt: 50 })],
			}),
			[createSummary("task-1", "running", 150)],
		);
		harness.sync.start();
		await settle();
		expect(harness.store.stored.revision).toBe(1);

		harness.fake.emit(createSummary("task-1", "awaiting_review", 500));
		await settle();

		expect(harness.columnIds("review")).toEqual(["task-1", "task-old"]);
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.updatedAt).toBe(10_000);
		expect(harness.store.stored.revision).toBe(2);
		expect(harness.onBoardMutated).toHaveBeenCalledWith(WORKSPACE_ID, WORKSPACE_PATH);
		expect(harness.moves).toEqual([
			{ taskId: "task-1", from: "in_progress", to: "review", sessionState: "awaiting_review" },
		]);
	});

	it("moves a Review card back to In Progress when its session runs again", async () => {
		const harness = createHarness(
			createBoard({
				in_progress: [createCard({ id: "task-other", updatedAt: 0 })],
				review: [createCard({ id: "task-1", updatedAt: 100 })],
			}),
			[createSummary("task-1", "awaiting_review", 90)],
		);
		harness.sync.start();
		harness.fake.emit(createSummary("task-1", "running", 500));
		await settle();
		expect(harness.columnIds("in_progress")).toEqual(["task-1", "task-other"]);
	});

	it("leaves an interrupted card where it is (no interrupted → Done)", async () => {
		const harness = createHarness(createBoard({ review: [createCard({ id: "task-1", updatedAt: 100 })] }), [
			createSummary("task-1", "running", 90),
		]);
		harness.sync.start();
		harness.fake.emit(createSummary("task-1", "interrupted", 500));
		await harness.sync.syncWorkspace(WORKSPACE_ID);
		expect(harness.columnOf("task-1")).toBe("review");
		expect(harness.store.stored.revision).toBe(1);
	});

	it("does not move a card on a stale summary, e.g. a card moved by hand after its session ended", async () => {
		const harness = createHarness(
			// Dragged back to In Progress at 300 for a rework; the summary still says the old turn ended at 200.
			createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 300 })] }),
			[createSummary("task-1", "awaiting_review", 200)],
		);
		harness.sync.start();
		await harness.sync.syncWorkspace(WORKSPACE_ID);
		expect(harness.columnOf("task-1")).toBe("in_progress");
		expect(harness.store.stored.revision).toBe(1);
	});

	it("syncs a tracked workspace once on start (summaries restored before the server started)", async () => {
		const harness = createHarness(createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 100 })] }), [
			createSummary("task-1", "awaiting_review", 200),
		]);
		expect(harness.columnOf("task-1")).toBe("in_progress");
		harness.sync.start();
		await settle();
		expect(harness.columnOf("task-1")).toBe("review");
	});

	it("reads no board while no session could move a card, and ignores summary updates without a state change", async () => {
		const harness = createHarness(createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 100 })] }), [
			createSummary("task-1", "idle", 90),
		]);
		harness.sync.start();
		await harness.sync.syncWorkspace(WORKSPACE_ID);
		expect(harness.boardReads()).toBe(0);

		harness.fake.emit(createSummary("task-1", "running", 200));
		await settle();
		const readsAfterStart = harness.boardReads();
		expect(readsAfterStart).toBe(1);
		// Output and hook activity: same state, newer summary. No sync is triggered by them.
		for (let index = 0; index < 20; index += 1) {
			harness.fake.emit(createSummary("task-1", "running", 300 + index, { lastOutputAt: 300 + index }));
		}
		await settle();
		expect(harness.boardReads()).toBe(readsAfterStart);
		expect(harness.store.stored.revision).toBe(1);
	});

	it("catches a summary that became newer than its card on the sweep", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const harness = createHarness(
			createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 300 })] }),
			[createSummary("task-1", "awaiting_review", 200)],
			{ sweepIntervalMs: 1_000 },
		);
		harness.sync.start();
		await settle();
		expect(harness.columnOf("task-1")).toBe("in_progress");

		// A later summary update (no state change) makes the summary newer than the card.
		harness.fake.emit(createSummary("task-1", "awaiting_review", 400, { lastHookAt: 400 }));
		await settle();
		expect(harness.columnOf("task-1")).toBe("in_progress");

		vi.advanceTimersByTime(1_000);
		await settle();
		expect(harness.columnOf("task-1")).toBe("review");
	});

	it("stops following a workspace that is untracked or closed", async () => {
		const harness = createHarness(createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 100 })] }), [
			createSummary("task-1", "running", 90),
		]);
		harness.sync.start();
		harness.sync.untrackWorkspace(WORKSPACE_ID);
		expect(harness.fake.listenerCount()).toBe(0);
		harness.fake.emit(createSummary("task-1", "awaiting_review", 500));
		await settle();
		expect(harness.columnOf("task-1")).toBe("in_progress");

		harness.sync.trackWorkspace(WORKSPACE_ID, harness.fake.sessions);
		harness.sync.close();
		expect(harness.fake.listenerCount()).toBe(0);
	});

	it("re-checks the board inside the board step: a card moved meanwhile is left alone", async () => {
		const harness = createHarness(createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 100 })] }), [
			createSummary("task-1", "awaiting_review", 200),
		]);
		// The user dragged the card to Done before the sync's board step ran.
		harness.store.stored.board = createBoard({ trash: [createCard({ id: "task-1", updatedAt: 250 })] });
		harness.sync.start();
		await settle();
		expect(harness.columnOf("task-1")).toBe("trash");
		expect(harness.store.stored.revision).toBe(1);
	});

	// Ported from the kit's test/column-sync-ui-bounce.test.mjs (archive/devteam-kit@acf45dce): a finished turn must
	// stay in Review. The kit ended the turn in Kanban (hooks.ingest to_review) before moving the card, because an
	// open web UI moved a Review card whose summary still said "running" straight back to In Progress.
	it("keeps a finished turn in Review until the session really runs again (no bounce)", async () => {
		const harness = createHarness(createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 100 })] }), [
			createSummary("task-1", "running", 150),
		]);
		harness.sync.start();
		await settle();

		// The turn ends in the state machine (a TaskComplete/Stop hook, or the kit's hooks.ingest to_review).
		harness.setClock(1_000);
		harness.fake.emit(createSummary("task-1", "awaiting_review", 900));
		await settle();
		expect(harness.columnOf("task-1")).toBe("review");

		// Later summary updates and sweeps while the turn is over: nothing moves it back.
		harness.fake.emit(createSummary("task-1", "awaiting_review", 2_000, { lastHookAt: 2_000 }));
		await harness.sync.syncWorkspace(WORKSPACE_ID);
		await harness.sync.syncWorkspace(WORKSPACE_ID);
		expect(harness.columnOf("task-1")).toBe("review");
		expect(harness.moves).toHaveLength(1);

		// A rework starts a new turn (UserPromptSubmit/PreToolUse hook → running): back to In Progress.
		harness.setClock(3_000);
		harness.fake.emit(createSummary("task-1", "running", 2_500));
		await settle();
		expect(harness.columnOf("task-1")).toBe("in_progress");
		expect(harness.moves.map((move) => `${move.from}->${move.to}`)).toEqual([
			"in_progress->review",
			"review->in_progress",
		]);
	});

	it("moves a card someone put in Review while its summary still says running back only once the summary changes after that", async () => {
		// The kit's column-sync when its hooks.ingest to_review fails: it moves only the card (at 1_000).
		const harness = createHarness(createBoard({ review: [createCard({ id: "task-1", updatedAt: 1_000 })] }), [
			createSummary("task-1", "running", 900),
		]);
		harness.sync.start();
		await harness.sync.syncWorkspace(WORKSPACE_ID);
		expect(harness.columnOf("task-1")).toBe("review");

		// The session is still producing output after the move: it really is running.
		harness.fake.emit(createSummary("task-1", "running", 1_200, { lastOutputAt: 1_200 }));
		await harness.sync.syncWorkspace(WORKSPACE_ID);
		expect(harness.columnOf("task-1")).toBe("in_progress");
	});
});

// Auto-review and session sync on one board: the reconciler arms a Review card and types the commit prompt, the
// agent runs (summary "running"), commits, and the reconciler takes the card to Done. Session sync must not move
// the armed card to In Progress, or the reconciler disarms it and the card never reaches Done.
describe("session column sync with the auto-review reconciler", () => {
	function createAutoReviewHarness() {
		const card = createCard({ id: "task-1", autoReviewEnabled: true, updatedAt: 100 });
		const store = createWorkspaceStateStore({ board: createBoard({ review: [card] }), sessions: {}, revision: 1 });
		const fake = createFakeSessions([createSummary("task-1", "awaiting_review", 90)]);
		let clock = 1_000;
		let probe: AutoReviewTaskProbe = { exists: true, headCommit: "commit-1", changedFiles: 2 };
		const deliver = vi.fn(async (): Promise<DeliverTaskInputResult> => {
			// The prompt arrives: the agent's UserPromptSubmit hook sets the session running.
			clock += 10;
			fake.emit(createSummary("task-1", "running", clock));
			return { ok: true, status: "delivered", evidence: "hook", enterAttempts: 1, summary: null };
		});
		const trashWorkflow = createTaskTrashWorkflow({
			...createFakeTaskTrashWorkflowDependencies(store).dependencies,
			now: () => clock,
		});
		const terminalManager = { getSummary: (taskId: string) => ({ taskId }) } as unknown as TerminalSessionManager;
		const reconciler = createAutoReviewReconciler({
			listWorkspaces: () => [{ workspaceId: WORKSPACE_ID, workspacePath: WORKSPACE_PATH, terminalManager }],
			getWorkspaceState: store.getWorkspaceState,
			mutateWorkspaceState: store.mutateWorkspaceState,
			trashTask: trashWorkflow.trashTask,
			getPromptTemplates: async () => null,
			probeTaskWorkspace: async () => probe,
			deliverTaskInput: deliver,
			now: () => clock,
		});
		const sync = createSessionColumnSync({
			listWorkspaces: () => [{ workspaceId: WORKSPACE_ID, workspacePath: WORKSPACE_PATH }],
			mutateWorkspaceState: store.mutateWorkspaceState,
			now: () => clock,
		});
		sync.trackWorkspace(WORKSPACE_ID, fake.sessions);
		sync.start();
		return {
			store,
			fake,
			deliver,
			sync,
			reconciler,
			columnOf: (taskId: string) => findCardInBoard(store.stored.board, taskId)?.columnId ?? null,
			setProbe: (next: AutoReviewTaskProbe) => {
				probe = next;
			},
			tick: (ms: number) => {
				clock += ms;
			},
			close: () => {
				sync.close();
				reconciler.close();
			},
		};
	}

	it("keeps the armed card in Review while the agent commits, and the reconciler lands it in Done", async () => {
		const harness = createAutoReviewHarness();
		try {
			await harness.reconciler.evaluateWorkspace(WORKSPACE_ID);
			await settle();
			expect(harness.deliver).toHaveBeenCalledTimes(1);
			await harness.sync.syncWorkspace(WORKSPACE_ID);
			expect(harness.columnOf("task-1")).toBe("review");
			expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();

			// The reconciler's next cycles while the agent works: still armed, nothing typed again.
			harness.tick(5_000);
			await harness.reconciler.evaluateWorkspace(WORKSPACE_ID);
			await harness.sync.syncWorkspace(WORKSPACE_ID);
			expect(harness.columnOf("task-1")).toBe("review");
			expect(harness.deliver).toHaveBeenCalledTimes(1);

			// The agent committed: HEAD moved, the reconciler takes the card to Done.
			harness.setProbe({ exists: true, headCommit: "commit-2", changedFiles: 0 });
			harness.tick(5_000);
			await harness.reconciler.evaluateWorkspace(WORKSPACE_ID);
			await settle();
			expect(harness.columnOf("task-1")).toBe("trash");
			expect(harness.deliver).toHaveBeenCalledTimes(1);
		} finally {
			harness.close();
		}
	});

	it("still moves the card to In Progress once auto-review disarmed it (a user's rework)", async () => {
		const harness = createAutoReviewHarness();
		try {
			harness.setProbe({ exists: true, headCommit: "commit-1", changedFiles: 0 });
			await harness.reconciler.evaluateWorkspace(WORKSPACE_ID);
			expect(harness.deliver).not.toHaveBeenCalled();
			harness.tick(10);
			harness.fake.emit(createSummary("task-1", "running", 1_010));
			await settle();
			expect(harness.columnOf("task-1")).toBe("in_progress");
		} finally {
			harness.close();
		}
	});
});

// The P2-2b guard: an open, idle Cline CLI TUI can leave its summary "running" with no turn in progress. Session
// sync asks Cline's session files (evaluateClineTurnEnd, requireStatus false) before it moves such a Review card
// back to In Progress. Fakes only: no real session files, no Cline process.
describe("session column sync with the Cline CLI idle-TUI check", () => {
	const NOW = 1_800_000_000_000;
	const RUNNING_SINCE = NOW - 600_000;

	// A final reply without a STATUS line, written a minute ago: over with requireStatus false.
	const IDLE_FINAL_REPLY: ClineSessionSnapshot = {
		sessionId: "1_a",
		status: "idle",
		startedAt: RUNNING_SINCE,
		messagesWrittenAt: NOW - 60_000,
		lastMessage: { role: "assistant", content: [{ type: "text", text: "Here is what I changed." }] },
	};
	// The model is calling a tool: the turn is running.
	const WORKING: ClineSessionSnapshot = {
		...IDLE_FINAL_REPLY,
		status: "running",
		messagesWrittenAt: NOW - 1_000,
		lastMessage: { role: "assistant", content: [{ type: "tool_use" }] },
	};

	function clineSummary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}) {
		return createSummary(taskId, "running", NOW - 30_000, {
			agentId: "cline",
			pid: 4321,
			workspacePath: `/wt/${taskId}/repo`,
			...overrides,
		});
	}

	function createClineHarness(input: {
		cards: ReturnType<typeof createCard>[];
		summaries: RuntimeTaskSessionSummary[];
		mode?: ClineTurnDetectorMode;
		session?: ClineSessionSnapshot | null;
		selectedAgentId?: "cline" | "claude";
	}) {
		const store = createWorkspaceStateStore({
			board: createBoard({ review: input.cards }),
			sessions: {},
			revision: 1,
		});
		const readLatestSession = vi.fn<ClineSessionFileReader["readLatestSession"]>(
			async () => input.session ?? IDLE_FINAL_REPLY,
		);
		const getSelectedAgentId = vi.fn(async () => input.selectedAgentId ?? "claude");
		const log = vi.fn();
		const moves: SessionColumnMove[] = [];
		const sync = createSessionColumnSync({
			listWorkspaces: () => [{ workspaceId: WORKSPACE_ID, workspacePath: WORKSPACE_PATH }],
			mutateWorkspaceState: store.mutateWorkspaceState,
			onMoved: (_workspaceId, applied) => moves.push(...applied),
			clineTurnCheck: {
				loadSettings: async () => ({ mode: input.mode ?? "on", intervalSec: 15, dataDir: "/cline-data" }),
				getSelectedAgentId,
				log,
				reader: { readLatestSession },
			},
			now: () => NOW,
		});
		const fake = createFakeSessions(
			input.summaries,
			new Map(input.summaries.map((summary) => [summary.taskId, RUNNING_SINCE])),
		);
		sync.trackWorkspace(WORKSPACE_ID, fake.sessions);
		return {
			store,
			sync,
			moves,
			log,
			readLatestSession,
			getSelectedAgentId,
			columnOf: (taskId: string) => findCardInBoard(store.stored.board, taskId)?.columnId ?? null,
			syncOnce: async () => {
				await sync.syncWorkspace(WORKSPACE_ID);
			},
		};
	}

	it("keeps an idle Cline TUI's card in Review although its session says running, and logs it once", async () => {
		const harness = createClineHarness({
			cards: [createCard({ id: "task-1", updatedAt: 100, agentId: "cline" })],
			summaries: [clineSummary("task-1")],
		});
		await harness.syncOnce();
		await harness.syncOnce();

		expect(harness.columnOf("task-1")).toBe("review");
		expect(harness.store.stored.revision).toBe(1);
		expect(harness.moves).toEqual([]);
		expect(harness.readLatestSession).toHaveBeenCalledWith("/cline-data/sessions", "/wt/task-1/repo");
		expect(harness.log).toHaveBeenCalledTimes(1);
		expect(harness.log.mock.calls[0]?.[0]).toContain("kept task-1 in Review");
		expect(harness.log.mock.calls[0]?.[0]).toContain("final_reply");
	});

	it("moves a Cline card back to In Progress when its turn really is running", async () => {
		const harness = createClineHarness({
			cards: [createCard({ id: "task-1", updatedAt: 100, agentId: "cline" })],
			summaries: [clineSummary("task-1")],
			session: WORKING,
		});
		await harness.syncOnce();

		expect(harness.columnOf("task-1")).toBe("in_progress");
		expect(harness.moves).toEqual([
			{ taskId: "task-1", from: "review", to: "in_progress", sessionState: "running" },
		]);
		expect(harness.log).not.toHaveBeenCalled();
	});

	it("moves a non-Cline running card back as before, without reading session files", async () => {
		const harness = createClineHarness({
			cards: [createCard({ id: "task-1", updatedAt: 100, agentId: "cline" })],
			// The session's agent is the effective agent, whatever the card says.
			summaries: [clineSummary("task-1", { agentId: "claude" })],
		});
		await harness.syncOnce();

		expect(harness.columnOf("task-1")).toBe("in_progress");
		expect(harness.readLatestSession).not.toHaveBeenCalled();
		expect(harness.getSelectedAgentId).not.toHaveBeenCalled();
	});

	it("decides on the effective agent: a card naming no agent runs on the selected one", async () => {
		const onCline = createClineHarness({
			cards: [createCard({ id: "task-1", updatedAt: 100 })],
			summaries: [clineSummary("task-1", { agentId: null })],
			selectedAgentId: "cline",
		});
		await onCline.syncOnce();
		expect(onCline.columnOf("task-1")).toBe("review");
		expect(onCline.getSelectedAgentId).toHaveBeenCalledWith(WORKSPACE_ID, WORKSPACE_PATH);

		const onClaude = createClineHarness({
			cards: [createCard({ id: "task-1", updatedAt: 100 })],
			summaries: [clineSummary("task-1", { agentId: null })],
			selectedAgentId: "claude",
		});
		await onClaude.syncOnce();
		expect(onClaude.columnOf("task-1")).toBe("in_progress");
		expect(onClaude.readLatestSession).not.toHaveBeenCalled();
	});

	it("only logs in mode report, once per reply, and moves the card as before", async () => {
		const harness = createClineHarness({
			cards: [
				createCard({ id: "task-1", updatedAt: 100, agentId: "cline" }),
				createCard({ id: "task-2", updatedAt: 100, agentId: "cline" }),
			],
			summaries: [clineSummary("task-1"), clineSummary("task-2")],
			mode: "report",
		});
		await harness.syncOnce();

		expect(harness.columnOf("task-1")).toBe("in_progress");
		expect(harness.columnOf("task-2")).toBe("in_progress");
		expect(harness.log).toHaveBeenCalledTimes(2);
		expect(harness.log.mock.calls[0]?.[0]).toContain("report only: would keep task-1 in Review");
	});

	it("reads no session files in mode off and moves the card as before", async () => {
		const harness = createClineHarness({
			cards: [createCard({ id: "task-1", updatedAt: 100, agentId: "cline" })],
			summaries: [clineSummary("task-1")],
			mode: "off",
		});
		await harness.syncOnce();

		expect(harness.columnOf("task-1")).toBe("in_progress");
		expect(harness.readLatestSession).not.toHaveBeenCalled();
		expect(harness.log).not.toHaveBeenCalled();
	});

	it("keeps the updatedAt and auto-review guards ahead of the check (no file read, no move)", async () => {
		const pendingGitAction = { action: "commit" as const, requestedAt: 100, headCommitAtRequest: "c1", attempt: 0 };
		const harness = createClineHarness({
			cards: [
				// Moved by hand after the session last changed: the summary is stale.
				createCard({ id: "stale", updatedAt: NOW, agentId: "cline" }),
				createCard({ id: "armed", updatedAt: 100, agentId: "cline", autoReviewEnabled: true, pendingGitAction }),
			],
			summaries: [clineSummary("stale"), clineSummary("armed")],
			session: WORKING,
		});
		await harness.syncOnce();

		expect(harness.columnOf("stale")).toBe("review");
		expect(harness.columnOf("armed")).toBe("review");
		expect(harness.store.stored.revision).toBe(1);
		expect(harness.readLatestSession).not.toHaveBeenCalled();
	});

	it("moves a Cline card whose session has no live process without reading files", async () => {
		const harness = createClineHarness({
			cards: [createCard({ id: "task-1", updatedAt: 100, agentId: "cline" })],
			summaries: [clineSummary("task-1", { pid: null })],
		});
		await harness.syncOnce();

		expect(harness.columnOf("task-1")).toBe("in_progress");
		expect(harness.readLatestSession).not.toHaveBeenCalled();
	});
});
