// The watchdog's sidebar wakes never type into the user's half-written message (issue #35): held while the session
// manager's one "is the user typing" rule says so, merged per workspace, typed once as soon as the input clears.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskInputDeliveryResponse, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createOrchestratorWakeHold, mergeHeldWakeTexts } from "../../../src/server/orchestrator-wake-hold";
import { createWatchdogActionHandler } from "../../../src/server/watchdog-actions";
import { TerminalSessionManager, VIEWER_TYPING_QUIET_MS } from "../../../src/terminal/session-manager";

const TASK_ID = "__home_agent__:foo:claude";

function createSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: TASK_ID,
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
function createSidebar(): { manager: TerminalSessionManager; ptyWrites: string[]; endProcess: () => void } {
	const manager = new TerminalSessionManager();
	manager.hydrateFromRecord({ [TASK_ID]: createSummary() });
	const ptyWrites: string[] = [];
	const entry = (manager as unknown as { entries: Map<string, { active: unknown }> }).entries.get(TASK_ID);
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

function setup() {
	const sidebar = createSidebar();
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
	const hold = createOrchestratorWakeHold({
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
		wakeHold: hold,
	});
	const wake = async (text: string) =>
		await handle({ kind: "deliverInput", workspaceId: "foo", taskId: TASK_ID, text, fromWorkspaceId: "foo" });
	const type = (keys: string) => sidebar.manager.writeInput(TASK_ID, Buffer.from(keys), { fromViewer: true });
	return { ...sidebar, hold, wake, type, delivered, deliver, log };
}

describe("orchestrator wake hold (issue #35)", () => {
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
		expect(hold.pending("foo")).toBe(0);
	});

	it("holds a wake while the user has half-typed text and types it once after Enter plus the quiet time", async () => {
		const { wake, type, delivered, hold, ptyWrites } = setup();
		type("ok looks like that got done but the image hasn't be");

		expect(await wake("[kanban watchdog] wake 1")).toMatchObject({ ok: true, status: "queued" });
		expect(delivered).toEqual([]);
		// Nothing of the wake reached the PTY: only the user's own keys.
		expect(ptyWrites).toEqual(["ok looks like that got done but the image hasn't be"]);
		expect(hold.pending("foo")).toBe(1);

		// Still typing (no Enter), long after the quiet time: held.
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS * 5);
		expect(await hold.flush()).toBe(0);

		type("en updated\r");
		vi.advanceTimersByTime(VIEWER_TYPING_QUIET_MS - 1);
		expect(await hold.flush()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(await hold.flush()).toBe(1);
		expect(delivered).toEqual(["[kanban watchdog] wake 1"]);
		expect(hold.pending("foo")).toBe(0);
		expect(await hold.flush()).toBe(0);
		expect(delivered).toHaveLength(1);
	});

	it("merges two wakes that arrive while blocked into one delivery", async () => {
		const { wake, type, delivered, hold, deliver } = setup();
		type("half a message");
		expect(await wake("[kanban watchdog 11:19Z] item A")).toMatchObject({ status: "queued" });
		expect(await wake("[kanban watchdog 11:20Z] item B")).toMatchObject({ status: "queued" });
		expect(hold.pending("foo")).toBe(2);

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
		const hold = createOrchestratorWakeHold({ getTerminal: () => sidebar.manager, deliver, log, maxHoldMs: 60_000 });
		sidebar.manager.writeInput(TASK_ID, Buffer.from("draft"), { fromViewer: true });
		await hold.deliver("foo", TASK_ID, "wake 1");
		sidebar.endProcess();
		vi.advanceTimersByTime(59_999);
		await hold.flush();
		expect(hold.pending("foo")).toBe(1);
		vi.advanceTimersByTime(1);
		await hold.flush();
		expect(hold.pending("foo")).toBe(0);
		expect(deliver).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("dropped a wake held 1 min"));
	});

	it("merges texts in order, each once, and keeps an Enter-only wake as an Enter", () => {
		expect(mergeHeldWakeTexts(["a", "", "b", "a"])).toBe("a b");
		expect(mergeHeldWakeTexts([""])).toBe("");
	});
});
