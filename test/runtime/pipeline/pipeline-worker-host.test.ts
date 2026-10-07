import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { WatchdogActionRequest } from "../../../src/pipeline/watchdog/actions";
import { createPipelineWorkerHost, type PipelineWorkerChild } from "../../../src/pipeline/worker-host";
import type { PipelineHostMessage } from "../../../src/pipeline/worker-protocol";
import { createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard } from "../../utilities/workspace-state-store";

interface FakeChild extends PipelineWorkerChild {
	sent: PipelineHostMessage[];
	emitMessage: (message: unknown) => void;
	exit: (code: number | null) => void;
	killed: boolean;
}

function createFakeChild(pid: number): FakeChild {
	const messageListeners: Array<(message: unknown) => void> = [];
	const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
	const child: FakeChild = {
		pid,
		sent: [],
		killed: false,
		send: (message) => {
			child.sent.push(message);
		},
		onMessage: (listener) => {
			messageListeners.push(listener);
		},
		onExit: (listener) => {
			exitListeners.push(listener);
		},
		kill: () => {
			child.killed = true;
		},
		emitMessage: (message) => {
			for (const listener of messageListeners) {
				listener(message);
			}
		},
		exit: (code) => {
			for (const listener of exitListeners) {
				listener(code, null);
			}
		},
	};
	return child;
}

function createHostHarness(
	initialConfig: unknown,
	options: { handleWatchdogRequest?: (request: WatchdogActionRequest) => Promise<unknown> } = {},
) {
	let rawConfig = initialConfig;
	const children: FakeChild[] = [];
	const spawnWorker = vi.fn((_entry: string | null) => {
		const child = createFakeChild(1000 + children.length);
		children.push(child);
		return child;
	});
	const buildSnapshot = vi.fn(async (workspaceId: string) =>
		createSnapshot({ workspaceId, board: createBoard({}), selectedAgentId: "claude" }),
	);
	const log = vi.fn();
	const host = createPipelineWorkerHost({
		listWorkspaces: () => [
			{ workspaceId: "foo", workspacePath: "/repos/foo" },
			{ workspaceId: "kanban-2uge", workspacePath: "/repos/kanban-2uge" },
		],
		buildSnapshot,
		readConfig: async () => parsePipelineConfig(rawConfig),
		spawnWorker,
		sweepIntervalMs: 30_000,
		coalesceMs: 2_000,
		restartDelaysMs: [1_000, 5_000],
		handleWatchdogRequest: options.handleWatchdogRequest,
		log,
	});
	const snapshotsSent = (child: FakeChild | undefined) =>
		(child?.sent ?? []).flatMap((message) => (message.type === "snapshot" ? [message.snapshot.workspaceId] : []));
	return {
		host,
		children,
		spawnWorker,
		buildSnapshot,
		log,
		snapshotsSent,
		setConfig: (next: unknown) => {
			rawConfig = next;
		},
		/** Starts the host and lets the first child report ready. */
		async startReady() {
			host.start();
			await vi.advanceTimersByTimeAsync(0);
			children.at(-1)?.emitMessage({ type: "ready", pid: 1 });
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

const QA_FOO = { workspaces: { foo: { landing: { mode: "qa" } } } };

function summary(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return { taskId, state } as RuntimeTaskSessionSummary;
}

describe("pipeline worker host", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("never starts a worker while no workspace has landing mode qa", async () => {
		const harness = createHostHarness({ workspaces: { foo: { landing: { mode: "commit" } } } });

		harness.host.start();
		await vi.advanceTimersByTimeAsync(120_000);
		harness.host.notifyActivity({ workspaceId: "foo" });
		await vi.advanceTimersByTimeAsync(5_000);

		expect(harness.spawnWorker).not.toHaveBeenCalled();
		expect(harness.buildSnapshot).not.toHaveBeenCalled();
		await harness.host.close();
	});

	it("starts the worker for a qa workspace and sends only that workspace's snapshot once it is ready", async () => {
		const harness = createHostHarness(QA_FOO);

		await harness.startReady();

		expect(harness.spawnWorker).toHaveBeenCalledWith(null);
		expect(harness.snapshotsSent(harness.children[0])).toEqual(["foo"]);
		expect(harness.host.getStatus()).toMatchObject({ running: true, workspaceIds: ["foo"] });
		await harness.host.close();
		expect(harness.children[0]?.sent.at(-1)).toEqual({ type: "shutdown" });
	});

	it("coalesces activity into one snapshot and ignores summaries that don't change the session state", async () => {
		const harness = createHostHarness(QA_FOO);
		await harness.startReady();
		const child = harness.children[0];
		const initial = harness.snapshotsSent(child).length;

		harness.host.notifyActivity({ workspaceId: "foo", summary: summary("dev-1", "running") });
		harness.host.notifyActivity({ workspaceId: "foo" });
		harness.host.notifyActivity({ workspaceId: "kanban-2uge" });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(harness.snapshotsSent(child).length).toBe(initial + 1);

		// Output and hook activity: same state, no snapshot.
		harness.host.notifyActivity({ workspaceId: "foo", summary: summary("dev-1", "running") });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(harness.snapshotsSent(child).length).toBe(initial + 1);

		harness.host.notifyActivity({ workspaceId: "foo", summary: summary("dev-1", "awaiting_review") });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(harness.snapshotsSent(child).length).toBe(initial + 2);
		await harness.host.close();
	});

	it("restarts a worker that died, after a delay", async () => {
		const harness = createHostHarness(QA_FOO);
		await harness.startReady();

		harness.children[0]?.exit(1);
		expect(harness.host.getStatus().running).toBe(false);
		await vi.advanceTimersByTimeAsync(999);
		expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.spawnWorker).toHaveBeenCalledTimes(2);
		expect(harness.host.getStatus()).toMatchObject({ running: true, restarts: 1 });

		// A second quick crash waits longer.
		harness.children[1]?.exit(1);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(harness.spawnWorker).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.spawnWorker).toHaveBeenCalledTimes(3);
		await harness.host.close();
	});

	it("stops the worker when the last qa workspace goes back to landing off, and forgets dropped workspaces", async () => {
		const harness = createHostHarness({
			workspaces: { foo: { landing: { mode: "qa" } }, "kanban-2uge": { landing: { mode: "qa" } } },
		});
		await harness.startReady();
		const child = harness.children[0];

		harness.setConfig(QA_FOO);
		await harness.host.sweep();
		expect(child?.sent).toContainEqual({ type: "forget", workspaceId: "kanban-2uge" });

		harness.setConfig({});
		await harness.host.sweep();
		expect(child?.sent.at(-1)).toEqual({ type: "shutdown" });
		expect(harness.host.getStatus().running).toBe(false);
		// Its exit after a requested stop is not a crash.
		child?.exit(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
		await harness.host.close();
	});

	it("restarts the worker on another build when pipeline.workerEntry changes", async () => {
		const harness = createHostHarness(QA_FOO);
		await harness.startReady();

		harness.setConfig({ ...QA_FOO, pipeline: { workerEntry: "/projects/kanban/dist/cli.js" } });
		await harness.host.sweep();

		expect(harness.children[0]?.sent.at(-1)).toEqual({ type: "shutdown" });
		expect(harness.spawnWorker).toHaveBeenLastCalledWith("/projects/kanban/dist/cli.js");
		await harness.host.close();
	});
});

describe("pipeline worker host: the watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs the worker for every workspace while watchdog.mode is not off, with no qa workspace", async () => {
		const harness = createHostHarness({ watchdog: { mode: "report" } });
		await harness.startReady();
		expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
		expect(harness.snapshotsSent(harness.children[0]).sort()).toEqual(["foo", "kanban-2uge"]);

		harness.setConfig({});
		await harness.host.sweep();
		expect(harness.children[0]?.sent.at(-1)).toEqual({ type: "shutdown" });
		await harness.host.close();
	});

	it("answers the worker's requests with the server's handler, and errors as ok: false", async () => {
		const handleWatchdogRequest = vi.fn(async (request: WatchdogActionRequest) => {
			if (request.kind === "sweepProcesses") {
				throw new Error("no /proc");
			}
			return { ok: true, taskId: "x" };
		});
		const harness = createHostHarness({ watchdog: { mode: "on" } }, { handleWatchdogRequest });
		await harness.startReady();
		const child = harness.children[0];
		child?.emitMessage({
			type: "request",
			id: 7,
			request: { kind: "startOrchestratorSession", workspaceId: "foo", agentId: "claude", prompt: "wake" },
		});
		child?.emitMessage({ type: "request", id: 8, request: { kind: "sweepProcesses" } });
		await vi.advanceTimersByTimeAsync(0);
		expect(child?.sent.filter((message) => message.type === "response")).toEqual([
			{ type: "response", id: 7, ok: true, result: { ok: true, taskId: "x" } },
			{ type: "response", id: 8, ok: false, error: "no /proc" },
		]);
		await harness.host.close();
	});
});
