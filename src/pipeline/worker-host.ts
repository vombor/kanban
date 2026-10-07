// The server side of the pipeline worker (decision 1, plan §5): starts `kanban pipeline worker` as a child
// process, restarts it when it dies, and feeds it workspace snapshots.
//
// - The worker runs only while some registered workspace has landing mode `qa` and `pipeline.paused` is off. A
//   pod where every workspace is on landing `off` (every workspace without a config entry) never starts it.
// - Every `sweepIntervalMs` the host re-reads config.json, so a landing-mode change starts or stops the worker
//   with no Kanban restart, and sends a snapshot of each pipeline workspace (a backstop for missed events).
// - Between sweeps, board writes and session state changes from the state hub send a snapshot of that workspace
//   after a short coalescing delay. Session summaries that don't change the state (output, hook activity) are
//   ignored.
// - The worker asks the server to finish a card (the Done workflow, with its landing step) with a `finishTask`
//   request; the host runs it and answers `finishTaskResult`. Lands from any trigger reach the worker as `landed`.
// - A worker that exits on its own is restarted after a growing delay. `pipeline.workerEntry` points the child at
//   another build's CLI (the dev pod's "fix it live" loop): the host runs `<workerEntry> pipeline worker`.
import { type ChildProcess, fork } from "node:child_process";

import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type {
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTrashResponse,
} from "../core/api-contract";
import { isPipelineWorkspace, type PipelineWorkspaceSnapshot } from "./engine";
import type { PipelineEventMap } from "./events";
import {
	isPipelineWorkerMessage,
	type PipelineFinishTaskRequest,
	type PipelineHostMessage,
	type PipelineWorkerMessage,
} from "./worker-protocol";

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_COALESCE_MS = 2_000;
const DEFAULT_RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
/** A worker that ran this long before dying starts the restart delays from the beginning again. */
const HEALTHY_UPTIME_MS = 5 * 60_000;
const SHUTDOWN_GRACE_MS = 2_000;

export interface PipelineWorkerChild {
	readonly pid: number | undefined;
	send: (message: PipelineHostMessage) => void;
	onMessage: (listener: (message: unknown) => void) => void;
	onExit: (listener: (code: number | null, signal: string | null) => void) => void;
	kill: () => void;
}

export interface PipelineWorkerHostWorkspace {
	workspaceId: string;
	workspacePath: string | null;
}

export interface CreatePipelineWorkerHostDependencies {
	listWorkspaces: () => PipelineWorkerHostWorkspace[];
	buildSnapshot: (workspaceId: string, workspacePath: string) => Promise<PipelineWorkspaceSnapshot | null>;
	readConfig?: () => Promise<ParsedPipelineConfig>;
	/** `entry`: `pipeline.workerEntry`, or null for this build. */
	spawnWorker?: (entry: string | null) => PipelineWorkerChild;
	onWorkerMessage?: (message: PipelineWorkerMessage) => void;
	/** Runs the Done workflow for a worker `finishTask` request (in-process triggers `pipeline`/`hold_release`). */
	finishTask?: (request: PipelineFinishTaskRequest) => Promise<RuntimeTaskTrashResponse>;
	sweepIntervalMs?: number;
	coalesceMs?: number;
	restartDelaysMs?: number[];
	now?: () => number;
	log: (message: string) => void;
}

export interface PipelineWorkerHostStatus {
	running: boolean;
	pid: number | null;
	restarts: number;
	workspaceIds: string[];
}

export interface PipelineWorkerHost {
	start: () => void;
	/** A board write (`summary` absent) or a session summary of a workspace (from the state hub). */
	notifyActivity: (activity: { workspaceId: string; summary?: RuntimeTaskSessionSummary }) => void;
	/** The workspace left the server. */
	forgetWorkspace: (workspaceId: string) => void;
	/** Kanban landed a card: tells the worker, which emits `landed` for kit features. */
	notifyLanded: (event: PipelineEventMap["landed"]) => void;
	/** Re-reads the config, starts or stops the worker, and sends every pipeline workspace's snapshot. */
	sweep: () => Promise<void>;
	getStatus: () => PipelineWorkerHostStatus;
	close: () => Promise<void>;
}

function wrapChildProcess(child: ChildProcess): PipelineWorkerChild {
	return {
		get pid() {
			return child.pid;
		},
		send: (message) => {
			if (child.connected) {
				child.send(message);
			}
		},
		onMessage: (listener) => {
			child.on("message", listener);
		},
		onExit: (listener) => {
			child.on("exit", (code, signal) => listener(code, signal));
		},
		kill: () => {
			child.kill("SIGTERM");
		},
	};
}

/** Forks `<entry> pipeline worker`. Without an entry it re-runs this process's CLI script with the same Node flags. */
export function spawnPipelineWorkerProcess(entry: string | null): PipelineWorkerChild {
	const script = entry ?? process.argv[1];
	if (!script) {
		throw new Error("Cannot locate the Kanban CLI script to start the pipeline worker.");
	}
	// Another build's entry is a bundled script; this build may run under a TS loader (`npm run dev`).
	return forkPipelineWorkerProcess(script, entry ? [] : process.execArgv);
}

/** Forks `<script> pipeline worker` with an IPC channel; its output goes to the server's stdout/stderr. */
export function forkPipelineWorkerProcess(script: string, execArgv: string[]): PipelineWorkerChild {
	return wrapChildProcess(
		fork(script, ["pipeline", "worker"], {
			stdio: ["ignore", "inherit", "inherit", "ipc"],
			execArgv,
			env: process.env,
		}),
	);
}

export function createPipelineWorkerHost(deps: CreatePipelineWorkerHostDependencies): PipelineWorkerHost {
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	const spawnWorker = deps.spawnWorker ?? spawnPipelineWorkerProcess;
	const restartDelays = deps.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
	const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
	const now = deps.now ?? Date.now;

	let child: PipelineWorkerChild | null = null;
	let childStartedAt = 0;
	let crashes = 0;
	let restarts = 0;
	let workerEntry: string | null = null;
	let restartTimer: NodeJS.Timeout | null = null;
	let sweepTimer: NodeJS.Timeout | null = null;
	let sweepRunning: Promise<void> | null = null;
	let closed = false;
	/** Pipeline workspaces as of the last sweep: workspaceId → workspacePath. */
	let pipelineWorkspaces = new Map<string, string>();
	const coalesceTimers = new Map<string, NodeJS.Timeout>();
	const lastSessionStates = new Map<string, RuntimeTaskSessionState>();

	const sendSnapshot = async (workspaceId: string, workspacePath: string): Promise<void> => {
		if (!child) {
			return;
		}
		try {
			const snapshot = await deps.buildSnapshot(workspaceId, workspacePath);
			if (snapshot && child && pipelineWorkspaces.has(workspaceId)) {
				child.send({ type: "snapshot", snapshot });
			}
		} catch (error) {
			deps.log(
				`pipeline ${workspaceId}: could not read the workspace for the worker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const answerFinishTask = async (
		from: PipelineWorkerChild,
		requestId: number,
		request: PipelineFinishTaskRequest,
	): Promise<void> => {
		let result: RuntimeTaskTrashResponse;
		try {
			if (!deps.finishTask) {
				throw new Error("this server does not finish pipeline tasks");
			}
			result = await deps.finishTask(request);
		} catch (error) {
			result = {
				ok: false,
				status: "failed",
				taskId: request.taskId,
				previousColumnId: null,
				readyTaskIds: [],
				autoStartedTasks: [],
				worktreeDeleted: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		// A worker that restarted meanwhile has forgotten the request.
		if (child === from) {
			from.send({ type: "finishTaskResult", requestId, result });
		}
	};

	const startChild = (): void => {
		if (child || closed) {
			return;
		}
		let started: PipelineWorkerChild;
		try {
			started = spawnWorker(workerEntry);
		} catch (error) {
			deps.log(`pipeline worker could not start: ${error instanceof Error ? error.message : String(error)}`);
			scheduleRestart();
			return;
		}
		child = started;
		childStartedAt = now();
		started.onMessage((message) => {
			if (!isPipelineWorkerMessage(message)) {
				return;
			}
			if (message.type === "log") {
				deps.log(message.message);
			} else if (message.type === "finishTask") {
				void answerFinishTask(started, message.requestId, message.request);
			} else if (message.type === "ready") {
				// Snapshots sent before the worker listened would be lost; send them all now.
				for (const [workspaceId, workspacePath] of pipelineWorkspaces) {
					void sendSnapshot(workspaceId, workspacePath);
				}
			}
			deps.onWorkerMessage?.(message);
		});
		started.onExit((code, signal) => {
			if (child !== started) {
				return;
			}
			child = null;
			if (closed || pipelineWorkspaces.size === 0) {
				return;
			}
			crashes = now() - childStartedAt >= HEALTHY_UPTIME_MS ? 1 : crashes + 1;
			deps.log(`pipeline worker exited (code ${code ?? "none"}, signal ${signal ?? "none"}); restarting`);
			scheduleRestart();
		});
	};

	function scheduleRestart(): void {
		if (closed || restartTimer) {
			return;
		}
		const delay = restartDelays[Math.min(Math.max(crashes - 1, 0), restartDelays.length - 1)] ?? 1_000;
		restartTimer = setTimeout(() => {
			restartTimer = null;
			if (!closed && pipelineWorkspaces.size > 0) {
				restarts += 1;
				startChild();
			}
		}, delay);
		restartTimer.unref();
	}

	const stopChild = (): void => {
		const current = child;
		child = null;
		if (!current) {
			return;
		}
		current.send({ type: "shutdown" });
		const killTimer = setTimeout(() => current.kill(), SHUTDOWN_GRACE_MS);
		killTimer.unref();
		current.onExit(() => clearTimeout(killTimer));
	};

	const runSweep = async (): Promise<void> => {
		const parsed = await readConfig();
		const config = parsed.config;
		const next = new Map<string, string>();
		if (!config.pipeline.paused) {
			for (const workspace of deps.listWorkspaces()) {
				if (
					workspace.workspacePath &&
					isPipelineWorkspace(getWorkspacePipelineSettings(config, workspace.workspaceId))
				) {
					next.set(workspace.workspaceId, workspace.workspacePath);
				}
			}
		}
		const previous = pipelineWorkspaces;
		pipelineWorkspaces = next;
		if (next.size === 0) {
			if (child) {
				deps.log("pipeline worker stopped: no workspace has landing mode qa");
			}
			stopChild();
			return;
		}
		const entryChanged = config.pipeline.workerEntry !== workerEntry;
		workerEntry = config.pipeline.workerEntry;
		if (child && entryChanged) {
			deps.log(`pipeline worker entry is now ${workerEntry ?? "this build"}; restarting the worker`);
			stopChild();
		}
		if (!child) {
			// The new child sends "ready", and the snapshots follow then.
			startChild();
			return;
		}
		for (const workspaceId of previous.keys()) {
			if (!next.has(workspaceId)) {
				child.send({ type: "forget", workspaceId });
			}
		}
		await Promise.all(
			[...next].map(async ([workspaceId, workspacePath]) => await sendSnapshot(workspaceId, workspacePath)),
		);
	};

	const sweep = async (): Promise<void> => {
		if (closed) {
			return;
		}
		sweepRunning ??= runSweep()
			.catch((error: unknown) => {
				deps.log(`pipeline sweep failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				sweepRunning = null;
			});
		await sweepRunning;
	};

	return {
		start: () => {
			if (closed || sweepTimer) {
				return;
			}
			sweepTimer = setInterval(() => void sweep(), deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
			sweepTimer.unref();
			void sweep();
		},
		notifyActivity: ({ workspaceId, summary }) => {
			if (summary) {
				const key = `${workspaceId}:${summary.taskId}`;
				const previous = lastSessionStates.get(key);
				lastSessionStates.set(key, summary.state);
				if (previous === summary.state) {
					return;
				}
			}
			const workspacePath = pipelineWorkspaces.get(workspaceId);
			if (!child || !workspacePath || coalesceTimers.has(workspaceId)) {
				return;
			}
			const timer = setTimeout(() => {
				coalesceTimers.delete(workspaceId);
				void sendSnapshot(workspaceId, workspacePath);
			}, coalesceMs);
			timer.unref();
			coalesceTimers.set(workspaceId, timer);
		},
		forgetWorkspace: (workspaceId) => {
			for (const key of [...lastSessionStates.keys()]) {
				if (key.startsWith(`${workspaceId}:`)) {
					lastSessionStates.delete(key);
				}
			}
			const timer = coalesceTimers.get(workspaceId);
			if (timer) {
				clearTimeout(timer);
				coalesceTimers.delete(workspaceId);
			}
			if (pipelineWorkspaces.delete(workspaceId)) {
				child?.send({ type: "forget", workspaceId });
			}
		},
		notifyLanded: (event) => {
			child?.send({ type: "landed", event });
		},
		sweep,
		getStatus: () => ({
			running: child !== null,
			pid: child?.pid ?? null,
			restarts,
			workspaceIds: [...pipelineWorkspaces.keys()],
		}),
		close: async () => {
			closed = true;
			if (sweepTimer) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
			if (restartTimer) {
				clearTimeout(restartTimer);
				restartTimer = null;
			}
			for (const timer of coalesceTimers.values()) {
				clearTimeout(timer);
			}
			coalesceTimers.clear();
			await sweepRunning;
			stopChild();
		},
	};
}
