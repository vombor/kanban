import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	createSessionSummaryPersister,
	type SessionSummaryPersisterSessions,
} from "../../../src/server/session-summary-persister";

function summary(taskId: string, updatedAt: number, state: RuntimeTaskSessionSummary["state"] = "running") {
	return {
		taskId,
		state,
		agentId: "claude",
		workspacePath: null,
		pid: 123,
		startedAt: 1,
		updatedAt,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
	} satisfies RuntimeTaskSessionSummary;
}

function createFakeSessions() {
	const listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	const sessions: SessionSummaryPersisterSessions & { emit: (summary: RuntimeTaskSessionSummary) => void } = {
		onSummary: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (value) => {
			for (const listener of listeners) {
				listener(value);
			}
		},
	};
	return { sessions, listenerCount: () => listeners.size };
}

describe("session summary persister", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes at most once per interval, with the newest summary of each task", async () => {
		const writes: Array<Record<string, RuntimeTaskSessionSummary>> = [];
		const persister = createSessionSummaryPersister({
			persist: async (_workspaceId, summaries) => {
				writes.push(summaries);
				return true;
			},
			intervalMs: 1000,
		});
		const { sessions } = createFakeSessions();
		persister.trackWorkspace("ws", sessions);

		// 200 changes over 2 s (one every 10 ms) on two tasks.
		for (let index = 0; index < 200; index += 1) {
			sessions.emit(summary(index % 2 === 0 ? "a" : "b", index));
			await vi.advanceTimersByTimeAsync(10);
		}
		await vi.advanceTimersByTimeAsync(1000);

		expect(writes.length).toBeGreaterThanOrEqual(2);
		expect(writes.length).toBeLessThanOrEqual(3);
		expect(writes.at(-1)?.a?.updatedAt).toBe(198);
		expect(writes.at(-1)?.b?.updatedAt).toBe(199);
		await persister.close();
	});

	it("doesn't start a second write while one is in flight", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const persister = createSessionSummaryPersister({
			persist: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 2500));
				inFlight -= 1;
				return true;
			},
			intervalMs: 100,
		});
		const { sessions } = createFakeSessions();
		persister.trackWorkspace("ws", sessions);
		for (let index = 0; index < 50; index += 1) {
			sessions.emit(summary("a", index));
			await vi.advanceTimersByTimeAsync(100);
		}
		await vi.advanceTimersByTimeAsync(10_000);
		expect(maxInFlight).toBe(1);
		await persister.close();
	});

	it("close writes what is queued and ignores summaries after it", async () => {
		const writes: Array<Record<string, RuntimeTaskSessionSummary>> = [];
		const persister = createSessionSummaryPersister({
			persist: async (_workspaceId, summaries) => {
				writes.push(summaries);
				return true;
			},
			intervalMs: 1000,
		});
		const { sessions, listenerCount } = createFakeSessions();
		persister.trackWorkspace("ws", sessions);
		sessions.emit(summary("a", 5, "running"));
		await persister.close();
		expect(writes).toEqual([{ a: summary("a", 5, "running") }]);
		expect(listenerCount()).toBe(0);

		// Shutdown stopping the session afterwards stays off disk: recovery must see "running".
		sessions.emit(summary("a", 6, "interrupted"));
		await vi.advanceTimersByTimeAsync(5000);
		expect(writes).toHaveLength(1);
	});

	it("drops a removed workspace's queue and keeps a failed write's summaries for the next one", async () => {
		const writes: Array<{ workspaceId: string; summaries: Record<string, RuntimeTaskSessionSummary> }> = [];
		let fail = true;
		const warn = vi.fn();
		const persister = createSessionSummaryPersister({
			persist: async (workspaceId, summaries) => {
				if (fail) {
					fail = false;
					throw new Error("disk full");
				}
				writes.push({ workspaceId, summaries });
				return true;
			},
			intervalMs: 1000,
			warn,
		});
		const kept = createFakeSessions();
		const removed = createFakeSessions();
		persister.trackWorkspace("kept", kept.sessions);
		persister.trackWorkspace("removed", removed.sessions);
		kept.sessions.emit(summary("a", 1));
		await vi.advanceTimersByTimeAsync(1000);
		expect(warn).toHaveBeenCalledOnce();
		removed.sessions.emit(summary("b", 1));
		persister.untrackWorkspace("removed");
		await vi.advanceTimersByTimeAsync(1000);
		expect(writes).toEqual([{ workspaceId: "kept", summaries: { a: summary("a", 1) } }]);
		await persister.close();
	});
});
