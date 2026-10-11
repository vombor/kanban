import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClineTurnDetectorMode, ClineTurnDetectorSettings } from "../../../src/config/cline-turn-detector-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { KANBAN_CLINE_HUB_ABORT_REASONS } from "../../../src/terminal/cline-hub-abort-reason";
import {
	type ClineSessionFileReader,
	createClineSessionFileReader,
	getClineSessionsPath,
} from "../../../src/terminal/cline-session-files";
import { type ClineTurnMonitorDependencies, createClineTurnMonitor } from "../../../src/terminal/cline-turn-monitor";
import { CLINE_TURN_END_REJECTED_QUIET_MS, type ClineSessionSnapshot } from "../../../src/terminal/cline-turn-outcome";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = 1_800_000_000_000;

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "ebe38",
		state: "running",
		agentId: "cline",
		workspacePath: "/wt/ebe38/foo",
		pid: 4321,
		startedAt: NOW - 600_000,
		updatedAt: NOW - 600_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		...overrides,
	};
}

const FINISHED: ClineSessionSnapshot = {
	sessionId: "1_a",
	status: "idle",
	startedAt: NOW - 600_000,
	messagesWrittenAt: NOW - 60_000,
	lastMessage: { role: "assistant", content: [{ type: "text", text: "Done.\nSTATUS: DONE" }] },
};

function createHarness(
	mode: ClineTurnDetectorMode,
	summaries: RuntimeTaskSessionSummary[],
	options: { reader?: ClineSessionFileReader; dataDir?: string } = {},
) {
	const manager = new TerminalSessionManager();
	manager.hydrateFromRecord(Object.fromEntries(summaries.map((entry) => [entry.taskId, entry])));
	const settings: ClineTurnDetectorSettings = { mode, intervalSec: 15, dataDir: options.dataDir ?? "/cline-data" };
	const reader: ClineSessionFileReader = options.reader ?? {
		readLatestSession: vi.fn(async () => FINISHED),
		readLatestSessionMessages: async () => null,
	};
	const endTurn = vi.fn<ClineTurnMonitorDependencies["endTurn"]>(async ({ taskId }) => {
		manager.transitionToReview(taskId, "hook");
		return { ok: true };
	});
	const log = vi.fn();
	const monitor = createClineTurnMonitor({
		listWorkspaces: () => [{ workspaceId: "ws-1", sessions: manager }],
		loadSettings: async () => settings,
		endTurn,
		log,
		reader,
		now: () => NOW,
	});
	return { manager, reader, endTurn, log, monitor, settings };
}

describe("cline turn monitor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW - 600_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("only logs in report mode, once per final reply, and changes nothing", async () => {
		const { manager, endTurn, log, monitor, reader } = createHarness("report", [summary()]);

		expect((await monitor.tick()).map((action) => action.outcome)).toEqual(["reported"]);
		await monitor.tick();

		expect(endTurn).not.toHaveBeenCalled();
		expect(manager.getSummary("ebe38")?.state).toBe("running");
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toContain("would end ebe38's turn (status_line STATUS: DONE)");
		expect(reader.readLatestSession).toHaveBeenCalledWith("/cline-data/sessions", "/wt/ebe38/foo");
	});

	it("ends the turn in Kanban in mode on, as the TaskComplete hook would", async () => {
		const { manager, endTurn, monitor } = createHarness("on", [summary()]);

		const actions = await monitor.tick();

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ workspaceId: "ws-1", taskId: "ebe38", outcome: "ended" });
		expect(endTurn).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("ebe38")).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
		// Not running any more: the next tick leaves it alone.
		expect(await monitor.tick()).toEqual([]);
	});

	it("reports a failed end and tries again on the next tick", async () => {
		const { endTurn, log, monitor } = createHarness("on", [summary()]);
		endTurn.mockResolvedValueOnce({ ok: false, error: "Task not found" });

		expect((await monitor.tick())[0]?.outcome).toBe("failed");
		expect(log.mock.calls[0]?.[0]).toContain("could not end ebe38's turn: Task not found");
		expect((await monitor.tick())[0]?.outcome).toBe("ended");
	});

	it("does nothing in mode off", async () => {
		const { reader, endTurn, monitor } = createHarness("off", [summary()]);

		expect(await monitor.tick()).toEqual([]);
		expect(reader.readLatestSession).not.toHaveBeenCalled();
		expect(endTurn).not.toHaveBeenCalled();
	});

	it("watches only live, running card sessions of agents that read turn ends from session files", async () => {
		const { reader, monitor } = createHarness("on", [
			summary({ taskId: "claude-card", agentId: "claude" }),
			summary({ taskId: "no-agent", agentId: null }),
			summary({ taskId: "in-review", state: "awaiting_review", reviewReason: "hook" }),
			summary({ taskId: "exited", pid: null }),
			summary({ taskId: createHomeAgentSessionId("ws-1", "cline") }),
		]);

		expect(await monitor.tick()).toEqual([]);
		expect(reader.readLatestSession).not.toHaveBeenCalled();
	});

	it("uses the time the session last turned running for the bounce rule", async () => {
		const { manager, monitor, reader, endTurn } = createHarness("on", [summary()]);
		// The final reply was written 60 s ago; the session went to review and back to running 10 s ago.
		vi.setSystemTime(NOW - 20_000);
		manager.transitionToReview("ebe38", "hook");
		vi.setSystemTime(NOW - 10_000);
		manager.transitionToRunning("ebe38");
		expect(manager.getStateEnteredAt("ebe38")).toBe(NOW - 10_000);

		expect(await monitor.tick()).toEqual([]);
		expect(reader.readLatestSession).toHaveBeenCalledTimes(1);
		expect(endTurn).not.toHaveBeenCalled();
	});
});

describe("cline turn monitor on Cline's error notices (issue #32 follow-up)", () => {
	let cleanups: Array<() => void> = [];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW - 600_000);
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const cleanup of cleanups) {
			cleanup();
		}
		cleanups = [];
	});

	const NOTICE = {
		role: "assistant",
		id: "error_1",
		content: [{ type: "text", text: "No model loaded: Devstral-Small-2507-GGUF" }],
		metadata: { displayRole: "error" },
	};

	/** A temp Cline data dir whose one session (cwd = the card's worktree) says "running" with these messages. */
	function createClineDataDir(messages: unknown[], writtenAt = NOW - CLINE_TURN_END_REJECTED_QUIET_MS): string {
		const temp = createTempDir("kanban-cline-turn-monitor-");
		cleanups.push(temp.cleanup);
		const id = "1791335760135_38ara";
		const dir = join(getClineSessionsPath(temp.path), id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({ status: "running", started_at: new Date(NOW - 600_000).toISOString(), cwd: "/wt/ebe38/foo" }),
		);
		const messagesPath = join(dir, `${id}.messages.json`);
		writeFileSync(
			messagesPath,
			JSON.stringify({ messages: [{ role: "user", content: "rework round 2" }, ...messages] }),
		);
		utimesSync(messagesPath, writtenAt / 1000, writtenAt / 1000);
		return temp.path;
	}

	function harnessOn(mode: ClineTurnDetectorMode, dataDir: string) {
		return createHarness(mode, [summary()], { reader: createClineSessionFileReader(), dataDir });
	}

	it("ends a turn whose only reply is an error notice while Cline's session file stays running", async () => {
		const { manager, endTurn, log, monitor } = harnessOn("on", createClineDataDir([NOTICE]));

		const actions = await monitor.tick();

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ outcome: "ended", decision: { reason: "provider_error" } });
		expect(endTurn).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("ebe38")?.state).toBe("awaiting_review");
		expect(log.mock.calls[0]?.[0]).toContain("ended ebe38's turn (provider_error)");
	});

	it("only reports it in report mode", async () => {
		const { manager, endTurn, log, monitor } = harnessOn("report", createClineDataDir([NOTICE]));

		expect((await monitor.tick()).map((action) => action.outcome)).toEqual(["reported"]);
		expect(endTurn).not.toHaveBeenCalled();
		expect(manager.getSummary("ebe38")?.state).toBe("running");
		expect(log.mock.calls[0]?.[0]).toContain("would end ebe38's turn (provider_error)");
	});

	it("waits the rejection quiet time after the notice", async () => {
		const { endTurn, monitor } = harnessOn("on", createClineDataDir([NOTICE], NOW - 30_000));

		expect(await monitor.tick()).toEqual([]);
		expect(endTurn).not.toHaveBeenCalled();
	});

	it("leaves a run Kanban ended through the hub alone (its abort reason is no provider error)", async () => {
		const aborted = {
			...NOTICE,
			content: [{ type: "text", text: KANBAN_CLINE_HUB_ABORT_REASONS.orphaned }],
		};
		const { endTurn, monitor } = harnessOn("on", createClineDataDir([aborted]));

		expect(await monitor.tick()).toEqual([]);
		expect(endTurn).not.toHaveBeenCalled();
	});

	it("does not end a turn that went on after the notice", async () => {
		const retried = { role: "assistant", content: [{ type: "tool_use", name: "read_files", input: {} }] };
		const { endTurn, monitor } = harnessOn(
			"on",
			createClineDataDir([NOTICE, { role: "user", content: "continue" }, retried]),
		);

		expect(await monitor.tick()).toEqual([]);
		expect(endTurn).not.toHaveBeenCalled();
	});
});
