import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskTokenUsage } from "../../../src/core/api-contract";
import { getDetailTerminalTaskId } from "../../../src/core/detail-terminal-session";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { createTaskTokenUsageMonitor } from "../../../src/server/task-token-usage-monitor";

const THROTTLE_MS = 5_000;

const usage = (taskId: string, output: number): RuntimeTaskTokenUsage => ({
	taskId,
	input: 1,
	output,
	cacheRead: 0,
	cacheWrite: 0,
});

describe("createTaskTokenUsageMonitor", () => {
	const monitors: Array<{ close: () => void }> = [];

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		for (const monitor of monitors.splice(0)) {
			monitor.close();
		}
		vi.useRealTimers();
	});

	function setup(options: { clients?: boolean } = {}) {
		let current: RuntimeTaskTokenUsage[] | null = [usage("aaaaa", 10), usage("bbbbb", 20)];
		const loadUsage = vi.fn(async (_workspaceId: string) => current);
		const broadcast = vi.fn<(workspaceId: string, usage: RuntimeTaskTokenUsage[]) => void>();
		let clients = options.clients ?? true;
		let running: string[] = [];
		const monitor = createTaskTokenUsageMonitor({
			loadUsage,
			hasClients: () => clients,
			listRunningWorkspaces: () => running,
			broadcast,
			throttleMs: THROTTLE_MS,
			now: () => Date.now(),
		});
		monitors.push(monitor);
		return {
			monitor,
			loadUsage,
			broadcast,
			setUsage: (next: RuntimeTaskTokenUsage[] | null) => {
				current = next;
			},
			setClients: (next: boolean) => {
				clients = next;
			},
			setRunning: (next: string[]) => {
				running = next;
			},
		};
	}

	it("reads at once on activity, then at most once per throttle, and pushes only the cards that changed", async () => {
		const { monitor, loadUsage, broadcast, setUsage } = setup();
		monitor.noteActivity("ws", "aaaaa");
		await vi.advanceTimersByTimeAsync(0);
		expect(loadUsage).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenLastCalledWith("ws", [usage("aaaaa", 10), usage("bbbbb", 20)]);

		setUsage([usage("aaaaa", 15), usage("bbbbb", 20)]);
		for (let i = 0; i < 20; i += 1) {
			monitor.noteActivity("ws", "aaaaa");
		}
		await vi.advanceTimersByTimeAsync(THROTTLE_MS - 1);
		expect(loadUsage).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(loadUsage).toHaveBeenCalledTimes(2);
		expect(broadcast).toHaveBeenLastCalledWith("ws", [usage("aaaaa", 15)]);
	});

	it("reads once more after a change and stops once the counts hold still", async () => {
		const { monitor, loadUsage, broadcast, setUsage } = setup();
		monitor.noteActivity("ws", "aaaaa");
		await vi.advanceTimersByTimeAsync(0);
		// The session file grows after the output that triggered the read.
		setUsage([usage("aaaaa", 30), usage("bbbbb", 20)]);
		await vi.advanceTimersByTimeAsync(THROTTLE_MS);
		expect(loadUsage).toHaveBeenCalledTimes(2);
		expect(broadcast).toHaveBeenLastCalledWith("ws", [usage("aaaaa", 30)]);
		await vi.advanceTimersByTimeAsync(THROTTLE_MS);
		expect(loadUsage).toHaveBeenCalledTimes(3);
		expect(broadcast).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(THROTTLE_MS * 10);
		expect(loadUsage).toHaveBeenCalledTimes(3);
	});

	it("reads nothing without a client, and ignores sidebar and detail terminal sessions", async () => {
		const { monitor, loadUsage, setClients } = setup({ clients: false });
		monitor.noteActivity("ws", "aaaaa");
		await vi.advanceTimersByTimeAsync(THROTTLE_MS);
		expect(loadUsage).not.toHaveBeenCalled();

		setClients(true);
		monitor.noteActivity("ws", createHomeAgentSessionId("ws", "claude"));
		monitor.noteActivity("ws", getDetailTerminalTaskId("aaaaa"));
		await vi.advanceTimersByTimeAsync(THROTTLE_MS);
		expect(loadUsage).not.toHaveBeenCalled();
	});

	it("keeps workspaces apart and forgets a workspace that is gone", async () => {
		const { monitor, loadUsage, broadcast, setUsage } = setup();
		monitor.noteActivity("ws-a", "aaaaa");
		monitor.noteActivity("ws-b", "aaaaa");
		await vi.advanceTimersByTimeAsync(0);
		expect(loadUsage.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(["ws-a", "ws-b"]);
		expect(broadcast.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(["ws-a", "ws-b"]);

		setUsage(null);
		await vi.advanceTimersByTimeAsync(THROTTLE_MS);
		monitor.close();
		monitor.noteActivity("ws-a", "aaaaa");
		await vi.advanceTimersByTimeAsync(THROTTLE_MS * 2);
		expect(broadcast).toHaveBeenCalledTimes(2);
	});

	it("re-reads a workspace with a running card every throttle, since output alone changes no summary", async () => {
		const { monitor, loadUsage, broadcast, setUsage, setRunning } = setup();
		await vi.advanceTimersByTimeAsync(THROTTLE_MS * 3);
		expect(loadUsage).not.toHaveBeenCalled();

		setRunning(["ws"]);
		// The sweep fires at the throttle; its read is the next timer.
		await vi.advanceTimersByTimeAsync(THROTTLE_MS + 1);
		expect(loadUsage).toHaveBeenCalledTimes(1);
		setUsage([usage("aaaaa", 40), usage("bbbbb", 20)]);
		await vi.advanceTimersByTimeAsync(THROTTLE_MS);
		expect(broadcast).toHaveBeenLastCalledWith("ws", [usage("aaaaa", 40)]);

		monitor.close();
		await vi.advanceTimersByTimeAsync(THROTTLE_MS * 3);
		expect(loadUsage).toHaveBeenCalledTimes(2);
	});
});
