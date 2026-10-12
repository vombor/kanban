import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { readTaskRunningTime } from "../../../src/core/task-running-time";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

const T0 = Date.parse("2026-10-12T10:00:00Z");

describe("TerminalSessionManager running time", () => {
	const exits: Array<() => void> = [];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		exits.length = 0;
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			exits.push(() => request.onExit?.({ exitCode: 0 }));
			return {
				pid: 1000 + exits.length,
				write: vi.fn(),
				resize: vi.fn(),
				pause: vi.fn(),
				resume: vi.fn(),
				stop: vi.fn(),
				wasInterrupted: vi.fn(() => false),
			};
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const start = async (manager: TerminalSessionManager) =>
		await manager.startTaskSession({
			taskId: "aaaaa",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/aaaaa",
			prompt: "Fix the bug",
		});

	it("sums the running spans of every turn and run, and counts the runs", async () => {
		const manager = new TerminalSessionManager();
		await start(manager);
		expect(manager.getSummary("aaaaa")).toMatchObject({ runCount: 1, firstRunStartedAt: T0 });

		vi.setSystemTime(T0 + 60_000);
		manager.transitionToReview("aaaaa", "hook");
		vi.setSystemTime(T0 + 10 * 60_000);
		manager.transitionToRunning("aaaaa");
		vi.setSystemTime(T0 + 10 * 60_000 + 30_000);
		manager.transitionToReview("aaaaa", "hook");
		expect(manager.getSummary("aaaaa")?.runningMs).toBe(90_000);

		// The process exits in Review: no running time is added; a second run counts on.
		exits[0]?.();
		vi.setSystemTime(T0 + 3_600_000);
		await start(manager);
		vi.setSystemTime(T0 + 3_600_000 + 45_000);
		const summary = manager.getSummary("aaaaa") as RuntimeTaskSessionSummary;
		expect(summary).toMatchObject({ runCount: 2, firstRunStartedAt: T0, runningMs: 90_000 });
		expect(readTaskRunningTime(summary, Date.now())?.totalMs).toBe(135_000);
	});

	it("ends a hydrated running span at its last update when the restart marks it interrupted", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			aaaaa: {
				taskId: "aaaaa",
				state: "running",
				agentId: "claude",
				workspacePath: "/tmp/aaaaa",
				pid: 4242,
				startedAt: T0 - 600_000,
				stateChangedAt: T0 - 600_000,
				updatedAt: T0 - 540_000,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				modelId: null,
				reasoningEffort: null,
				runningMs: 1_000,
				runCount: 1,
				firstRunStartedAt: T0 - 600_000,
			},
		});
		manager.markOrphanedSessionsInterrupted();
		expect(manager.getSummary("aaaaa")).toMatchObject({ state: "interrupted", runningMs: 61_000 });
	});
});
