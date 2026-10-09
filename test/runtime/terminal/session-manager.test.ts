import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { buildShellCommandLine } from "../../../src/core/shell";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		...overrides,
	};
}

describe("TerminalSessionManager", () => {
	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (sessionEntry: unknown, event: { type: "hook.to_review" }) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("cline", ["--auto-approve-all", "hello world"]);
		expect(commandLine).toContain("cline");
		expect(commandLine).toContain("--auto-approve-all");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("records stateChangedAt on state changes only (the review settle rule's clock)", () => {
		vi.useFakeTimers();
		try {
			const t0 = Date.parse("2026-10-07T10:00:00.000Z");
			vi.setSystemTime(t0);
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({ "task-1": createSummary({ state: "running" }) });

			vi.setSystemTime(t0 + 1_000);
			expect(manager.transitionToReview("task-1", "hook")?.stateChangedAt).toBe(t0 + 1_000);
			vi.setSystemTime(t0 + 2_000);
			const hooked = manager.applyHookActivity("task-1", { source: "copilot", activityText: "Done" });
			expect(hooked).toMatchObject({ stateChangedAt: t0 + 1_000, lastHookAt: t0 + 2_000 });
			vi.setSystemTime(t0 + 3_000);
			expect(manager.transitionToRunning("task-1")?.stateChangedAt).toBe(t0 + 3_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("marks every hydrated running session interrupted after a restart, newer than the stored summary", () => {
		vi.useFakeTimers();
		try {
			const t0 = Date.parse("2026-10-07T23:03:00.000Z");
			vi.setSystemTime(t0);
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				qa: createSummary({ taskId: "qa", state: "running", pid: 4242, updatedAt: t0 - 60_000 }),
				review: createSummary({ taskId: "review", state: "awaiting_review", updatedAt: t0 - 60_000 }),
				done: createSummary({ taskId: "done", state: "idle", pid: null, updatedAt: t0 - 60_000 }),
			});
			const emitted: string[] = [];
			manager.onSummary((summary) => emitted.push(`${summary.taskId}:${summary.state}`));

			const marked = manager.markOrphanedSessionsInterrupted();

			expect(marked).toEqual([
				expect.objectContaining({
					taskId: "qa",
					state: "interrupted",
					reviewReason: "interrupted",
					pid: null,
					updatedAt: t0,
					stateChangedAt: t0,
				}),
			]);
			expect(emitted).toEqual(["qa:interrupted"]);
			expect(manager.getSummary("review")?.state).toBe("awaiting_review");
			expect(manager.getSummary("done")?.state).toBe("idle");
			// Once marked, nothing is left to mark.
			expect(manager.markOrphanedSessionsInterrupted()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets stale running sessions without active processes", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBeNull();
		expect(recovered?.reviewReason).toBeNull();
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/kanban/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				session: {},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(onOutput).not.toHaveBeenCalled();
		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(false);
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				session: {
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = new TerminalSessionManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			summary: createSummary({ taskId: "task-restore", state: "running" }),
			active: null,
			terminalStateMirror: {
				getSnapshot: getSnapshotSpy,
			},
			restoreGeneration: 7,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
			restoreGeneration: 7,
		});
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});
});

describe("TerminalSessionManager viewer Enter (orchestrator waits, issue #10)", () => {
	function withActiveSession(manager: TerminalSessionManager, taskId: string): { write: ReturnType<typeof vi.fn> } {
		manager.hydrateFromRecord({ [taskId]: createSummary({ taskId }) });
		const session = { write: vi.fn() };
		const entries = (manager as unknown as { entries: Map<string, { active: unknown }> }).entries;
		const entry = entries.get(taskId);
		if (!entry) {
			throw new Error("no entry");
		}
		entry.active = { session, typedSinceEnter: false, viewerSubmittedAt: null, awaitingCodexPromptAfterEnter: false };
		return session;
	}

	it("records the viewer's Enter and tells listeners; Kanban's own deliveries and plain keys don't count", () => {
		vi.useFakeTimers();
		vi.setSystemTime(50_000);
		try {
			const manager = new TerminalSessionManager();
			const session = withActiveSession(manager, "__home_agent__:alpha:claude");
			const submitted = vi.fn();
			manager.onViewerInputSubmitted(submitted);

			manager.writeInput("__home_agent__:alpha:claude", Buffer.from("yes"), { fromViewer: true });
			manager.writeInput("__home_agent__:alpha:claude", Buffer.from("notice\r"));
			expect(manager.getViewerInputSubmittedAt("__home_agent__:alpha:claude")).toBe(null);
			expect(submitted).not.toHaveBeenCalled();

			manager.writeInput("__home_agent__:alpha:claude", Buffer.from("\r"), { fromViewer: true });
			expect(manager.getViewerInputSubmittedAt("__home_agent__:alpha:claude")).toBe(50_000);
			expect(submitted).toHaveBeenCalledWith("__home_agent__:alpha:claude");
			expect(session.write).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});
});
