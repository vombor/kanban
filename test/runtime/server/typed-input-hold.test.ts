// Kanban's own typed input never lands in the user's half-written message (issue #35): held while the session
// manager's one "is the user typing" rule says so, and typed once as soon as the input clears. The watchdog's sidebar
// wakes are merged per workspace; the pipeline's input into a card (recovery's nudges, the rework stage) is kept
// apart and typed in order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskInputDeliveryResponse, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createTypedInputHold, mergeHeldWakeTexts } from "../../../src/server/typed-input-hold";
import { createWatchdogActionHandler } from "../../../src/server/watchdog-actions";
import { TerminalSessionManager, VIEWER_TYPING_QUIET_MS } from "../../../src/terminal/session-manager";

const TASK_ID = "__home_agent__:foo:claude";
const CARD_ID = "a1b2c";

function createSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		modelId: null,
		reasoningEffort: null,
		workspacePath: "/projects/foo",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

/** A real session manager with a fake PTY, so the hold asks the real typing rule. */
function createSidebar(taskId = TASK_ID): {
	manager: TerminalSessionManager;
	ptyWrites: string[];
	endProcess: () => void;
} {
	const manager = new TerminalSessionManager();
	manager.hydrateFromRecord({ [taskId]: createSummary(taskId) });
	const ptyWrites: string[] = [];
	const entry = (manager as unknown as { entries: Map<string, { active: unknown }> }).entries.get(taskId);
	if (!entry) {
		throw new Error("no entry");
	}
	entry.active = {
		session: { write: (data: Buffer) => ptyWrites.push(data.toString("utf8")) },
		typedSinceEnter: false,
		viewerSubmittedAt: null,
		viewerTypedAt: null,
		awaitingCodexPromptAfterEnter: false,
	};
	return {
		manager,
		ptyWrites,
		endProcess: () => {
			entry.active = null;
		},
	};
}

function setup(taskId = TASK_ID) {
	const sidebar = createSidebar(taskId);
	const delivered: string[] = [];
	const deliver = vi.fn(async (_terminal: unknown, _taskId: string, text: string) => {
		delivered.push(text);
		return {
			ok: true,
			status: "delivered",
			evidence: "state",
			enterAttempts: 1,
			summary: null,
		} satisfies RuntimeTaskInputDeliveryResponse;
	});
	const log = vi.fn();
	const hold = createTypedInputHold({
		getTerminal: (workspaceId) => (workspaceId === "foo" ? sidebar.manager : null),
		deliver,
		log,
	});
	const handle = createWatchdogActionHandler({
		getWorkspacePathById: (workspaceId) => `/projects/${workspaceId}`,
		getTerminal: async () => sidebar.manager,
		startTaskSession: async () => ({ ok: true, summary: null }),
		runProcessSweep: async () => ({ supported: false, lastSweep: null }),
		onBoardMutated: async () => {},
		inputHold: hold,
	});
	const wake = async (text: string) =>
		await handle({ kind: "deliverInput", workspaceId: "foo", taskId, text, fromWorkspaceId: "foo" });
	// What the worker sends for recovery and the rework stage: a card's deliverInput names no board.
	const pipelineDeliver = async (text: string) =>
		await handle({ kind: "deliverInput", workspaceId: "foo", taskId, text });
	const type = (keys: string) => sidebar.manager.writeInput(taskId, Buffer.from(keys), { fromViewer: true });
	return { ...sidebar, hold, wake, pipelineDeliver, type, delivered, deliver, log };
}

describe("typed-input hold: orchestrator sidebar wakes (issue #35)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("types a wake at once when the user's input line is empty, as before", async () => {
		const { wake, delivered, hold } = setup();
		expect(await wake("[kanban watchdog] wake 1")).toMatchObject({ ok: true, status: "delivered" });
		expect(delivered).toEqual(["[kanban watchdog] wake 1"]);
		expect(hold.pending("foo", TASK_ID)).toBe(0);
	});

	it("holds a wake while the user has half-typed text and types it once after Enter plus the quiet time", async () => {
		const { wake, type, delivered, hold, ptyWrites } = setup();
		type("ok looks like that got done but the image hasn't be");

		expect(await wake("[kanban watchdog] wake 1")).toMatchObject({ ok: true, status: "queued" });
		expect(delivered).toEqual([]);
		// Nothing of the wake reached the PTY: only the user's own keys.
		expect(ptyWrites).toEqual(["ok looks like that got done but the image hasn't be"]);
		expect(hold.pending("foo", TASK_ID)).toBe(1);

		// Still typing (no Enter), long after the quiet time: held.
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS * 5);
		expect(await hold.flush()).toBe(0);

		type("en updated\r");
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS - 1);
		expect(await hold.flush()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(await hold.flush()).toBe(1);
		expect(delivered).toEqual(["[kanban watchdog] wake 1"]);
		expect(hold.pending("foo", TASK_ID)).toBe(0);
		expect(await hold.flush()).toBe(0);
		expect(delivered).toHaveLength(1);
	});

	it("merges two wakes that arrive while blocked into one delivery", async () => {
		const { wake, type, delivered, hold, deliver } = setup();
		type("half a message");
		expect(await wake("[kanban watchdog 11:19Z] item A")).toMatchObject({ status: "queued" });
		expect(await wake("[kanban watchdog 11:20Z] item B")).toMatchObject({ status: "queued" });
		expect(hold.pending("foo", TASK_ID)).toBe(2);

		type("\r");
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS);
		expect(await hold.flush()).toBe(1);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(delivered).toEqual(["[kanban watchdog 11:19Z] item A [kanban watchdog 11:20Z] item B"]);
	});

	it("a wake arriving while one is held joins it even once the user has stopped, and the poll delivers it", async () => {
		const { wake, type, delivered, hold } = setup();
		type("x");
		await wake("wake 1");
		type("\r");
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS);
		expect(await wake("wake 2")).toMatchObject({ status: "queued" });
		hold.start(1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		hold.close();
		expect(delivered).toEqual(["wake 1 wake 2"]);
	});

	it("keeps a hold whose session has gone, then drops it after maxHoldMs with a log line", async () => {
		const sidebar = createSidebar();
		const log = vi.fn();
		const deliver = vi.fn();
		const hold = createTypedInputHold({ getTerminal: () => sidebar.manager, deliver, log, maxHoldMs: 60_000 });
		sidebar.manager.writeInput(TASK_ID, Buffer.from("draft"), { fromViewer: true });
		await hold.deliver("foo", TASK_ID, "wake 1");
		sidebar.endProcess();
		vi.advanceTimersByTime(59_999);
		await hold.flush();
		expect(hold.pending("foo", TASK_ID)).toBe(1);
		vi.advanceTimersByTime(1);
		await hold.flush();
		expect(hold.pending("foo", TASK_ID)).toBe(0);
		expect(deliver).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("dropped 1 input(s) held 1 min"));
	});

	it("merges texts in order, each once, and keeps an Enter-only wake as an Enter", () => {
		expect(mergeHeldWakeTexts(["a", "", "b", "a"])).toBe("a b");
		expect(mergeHeldWakeTexts([""])).toBe("");
	});
});

describe("typed-input hold: pipeline input into a card (follow-up of issue #35)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("types a recovery nudge at once when the card's input line is empty, as before", async () => {
		const { pipelineDeliver, delivered, hold } = setup(CARD_ID);
		expect(await pipelineDeliver("continue")).toMatchObject({ ok: true, status: "delivered" });
		expect(delivered).toEqual(["continue"]);
		expect(hold.describe("foo", CARD_ID)).toEqual({ heldSince: null, typedAt: 1_000_000 });
	});

	it("holds a recovery nudge while the user has a draft in the card's terminal and types it once after Enter plus the quiet time", async () => {
		const { pipelineDeliver, type, delivered, hold, ptyWrites } = setup(CARD_ID);
		type("please also check the");

		expect(await pipelineDeliver("continue")).toMatchObject({ ok: true, status: "queued", enterAttempts: 0 });
		expect(delivered).toEqual([]);
		expect(ptyWrites).toEqual(["please also check the"]);
		expect(hold.describe("foo", CARD_ID)).toEqual({ heldSince: 1_000_000, typedAt: null });

		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS * 3);
		expect(await hold.flush()).toBe(0);
		type(" migrations\r");
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS - 1);
		expect(await hold.flush()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(await hold.flush()).toBe(1);
		expect(delivered).toEqual(["continue"]);
		expect(hold.describe("foo", CARD_ID)).toEqual({ heldSince: null, typedAt: Date.now() });
		expect(await hold.flush()).toBe(0);
		expect(delivered).toHaveLength(1);
	});

	it("with the real delivery, nothing of a held nudge reaches the PTY until the user is done, then text and Enter do", async () => {
		const card = createSidebar(CARD_ID);
		const hold = createTypedInputHold({ getTerminal: () => card.manager, log: vi.fn() });
		card.manager.writeInput(CARD_ID, Buffer.from("half a sentence"), { fromViewer: true });

		expect(await hold.deliver("foo", CARD_ID, "continue")).toMatchObject({ status: "queued" });
		expect(card.ptyWrites).toEqual(["half a sentence"]);

		card.manager.writeInput(CARD_ID, Buffer.from("\r"), { fromViewer: true });
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS);
		const flushed = hold.flush();
		await vi.advanceTimersByTimeAsync(20_000);
		await flushed;
		expect(card.ptyWrites.slice(0, 2)).toEqual(["half a sentence", "\r"]);
		expect(card.ptyWrites.slice(2).filter((write) => write !== "\u001b[I")).toEqual(["continue", "\r", "\r"]);
	});

	it("keeps a card's held inputs apart and types them in order, a settle time apart (a /clear and its message)", async () => {
		const { pipelineDeliver, type, delivered, hold } = setup(CARD_ID);
		type("draft");
		await pipelineDeliver("/clear");
		await pipelineDeliver("REWORK round 2: fix the failing test");
		expect(hold.pending("foo", CARD_ID)).toBe(2);
		type("\r");
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS);

		expect(await hold.flush()).toBe(1);
		expect(delivered).toEqual(["/clear"]);
		expect(hold.describe("foo", CARD_ID).heldSince).not.toBeNull();
		expect(await hold.flush()).toBe(0); // the settle time
		vi.advanceTimersByTime(1_500);
		expect(await hold.flush()).toBe(1);
		expect(delivered).toEqual(["/clear", "REWORK round 2: fix the failing test"]);
		expect(hold.describe("foo", CARD_ID).heldSince).toBeNull();
	});

	it("drops a card's held input at once when its session has no process, and logs it", async () => {
		const { pipelineDeliver, type, delivered, hold, endProcess, log } = setup(CARD_ID);
		type("draft");
		await pipelineDeliver("continue");
		endProcess();
		await hold.flush();
		expect(delivered).toEqual([]);
		expect(hold.describe("foo", CARD_ID)).toEqual({ heldSince: null, typedAt: null });
		expect(log).toHaveBeenCalledWith(expect.stringContaining("its session has no process"));
	});

	it("holds per card: a draft in one card's terminal doesn't hold another card's input", async () => {
		const first = createSidebar(CARD_ID);
		const second = createSidebar("f0e9d");
		const deliver = vi.fn(async () => ({
			ok: true,
			status: "delivered" as const,
			evidence: "state" as const,
			enterAttempts: 1,
			summary: null,
		}));
		const managers: Record<string, TerminalSessionManager> = { foo: first.manager, bar: second.manager };
		const hold = createTypedInputHold({ getTerminal: (id) => managers[id] ?? null, deliver, log: vi.fn() });
		first.manager.writeInput(CARD_ID, Buffer.from("draft"), { fromViewer: true });
		expect(await hold.deliver("foo", CARD_ID, "continue")).toMatchObject({ status: "queued" });
		expect(await hold.deliver("bar", "f0e9d", "continue")).toMatchObject({ status: "delivered" });
	});
});
