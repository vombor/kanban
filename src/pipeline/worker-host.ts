// The server side of the pipeline worker (decision 1, plan §5): starts `kanban pipeline worker` as a child
// process, restarts it when it dies, and feeds it workspace snapshots.
//
// - The worker runs only while some registered workspace has landing mode `qa` and `pipeline.paused` is off, or
//   while `watchdog.mode` is not "off" (then every registered workspace is sent: the watchdog's stuck-prompt check
//   covers all of them), or for a workspace recovery acts on (`pipeline.recovery.mode: "on"` with
//   `workspaces.<id>.recovery.enabled`, src/pipeline/recovery-stage.ts). A pod where every workspace is on landing
//   `off`, the watchdog is off and recovery is in its default `report` mode never starts it.
// - The worker's watchdog asks the server to act with `request` messages; `handleWatchdogRequest` answers them.
// - Every `sweepIntervalMs` the host re-reads config.json, so a landing-mode change starts or stops the worker
//   with no Kanban restart, and sends a snapshot of each pipeline workspace (a backstop for missed events).
// - Between sweeps, board writes and session state changes from the state hub send a snapshot of that workspace
//   after a short coalescing delay. Session summaries that don't change the state (output, hook activity) are
//   ignored. A session that enters Review also gets a snapshot once its Review has settled (`reviewSettleMs` plus
//   the coalescing delay): the pipeline acts on a Review card only then (src/terminal/review-settle.ts), and the
//   next sweep could be 30 s away. So does hook activity that moves a Review's settle clock without a state change
//   (a turn that ended while the card was already in Review, issue #20).
// - `requestSnapshot` sends a workspace's snapshot after the coalescing delay (`kanban task resubmit`).
// - The worker asks the server to finish a card (the Done workflow, with its landing step) with a `finishTask`
//   request; the host runs it and answers `finishTaskResult`. Lands from any trigger reach the worker as `landed`.
// - A worker that exits on its own is restarted after a growing delay. `pipeline.workerEntry` points the child at
//   another build's CLI (the dev pod's "fix it live" loop): the host runs `<workerEntry> pipeline worker`.
// - A worker `request` for a card action (the QA gate's create/start, the rework stage's update/block,
//   src/pipeline/actions.ts) runs through `runAction`, only for a workspace on landing mode `qa` (pipeline not paused)
//   as of the last sweep; anything else is refused, also while the watchdog has every workspace. `resumeTask`
//   (restart recovery runs on landing-off workspaces too, plan §12; the rework stage only runs on `qa` ones) and every
//   other `request` (a watchdog action, `handleWatchdogRequest`) are
//   accepted for any workspace the worker has. `applyIssues` (the issue import's sync job) only for a workspace the
//   worker has whose `issues.mode` is `on` as of the last sweep.
// - Every snapshot carries `pidPressure` (src/state/pid-pressure-flags.ts), read here when it is sent: the QA gate
//   and restart recovery hold new work on it, and the sweep's snapshot tells them within 30 s that it cleared.
import { type ChildProcess, fork } from "node:child_process";

import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type {
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTrashResponse,
} from "../core/api-contract";
import { type PidPressureFlags, readPidPressureFlags } from "../state/pid-pressure-flags";
import { DEFAULT_REVIEW_SETTLE_MS, getReviewActivityAt } from "../terminal/review-settle";
import type { PipelineActionRequest, PipelineActionResult } from "./actions";
import { getRecoveryScope, isPipelineWorkspace, type PipelineWorkspaceSnapshot } from "./engine";
import type { PipelineEventMap } from "./events";
import type { WatchdogActionRequest } from "./watchdog/actions";
import {
	isPipelineActionRequest,
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
	/** Carries out a watchdog action for the worker (src/server/watchdog-actions.ts). Without it requests fail. */
	handleWatchdogRequest?: (request: WatchdogActionRequest) => Promise<unknown>;
	/** Runs a worker's action request on the server (src/server/pipeline-actions.ts). */
	runAction?: (request: PipelineActionRequest) => Promise<PipelineActionResult>;
	/** `sessionSync.reviewSettleSec` in ms, as the server read it at start; also sent in every snapshot. */
	reviewSettleMs?: number;
	/** The PID pressure flags (default readPidPressureFlags()); sent as `pidPressure` in every snapshot. */
	readPidPressure?: () => Promise<PidPressureFlags>;
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
	/** Sends the workspace's snapshot after the coalescing delay, if the worker has it (`kanban task resubmit`). */
	requestSnapshot: (workspaceId: string) => void;
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
	const reviewSettleMs = deps.reviewSettleMs ?? DEFAULT_REVIEW_SETTLE_MS;
	const readPidPressure = deps.readPidPressure ?? (async () => await readPidPressureFlags());
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
	/** Workspaces sent to the worker as of the last sweep (pipeline workspaces, or all while the watchdog runs): id → path. */
	let pipelineWorkspaces = new Map<string, string>();
	/** The subset of `pipelineWorkspaces` on landing mode `qa`: the only ones the QA gate's card actions may touch. */
	let cardActionWorkspaces = new Map<string, string>();
	/** The subset of `pipelineWorkspaces` with `issues.mode: "on"`: the only ones `applyIssues` may write. */
	let issueWorkspaces = new Map<string, string>();
	const coalesceTimers = new Map<string, NodeJS.Timeout>();
	/** `workspaceId:taskId` → the snapshot sent once that session's Review has settled. */
	const settleTimers = new Map<string, NodeJS.Timeout>();
	/** `workspaceId:taskId` → the session's last state and its Review's settle clock (getReviewActivityAt). */
	const lastSessionStates = new Map<string, { state: RuntimeTaskSessionState; reviewActivityAt: number | null }>();

	const runAction = async (request: PipelineActionRequest): Promise<PipelineActionResult> => {
		const allowed =
			request.kind === "resumeTask"
				? pipelineWorkspaces
				: request.kind === "applyIssues"
					? issueWorkspaces
					: cardActionWorkspaces;
		if (allowed.get(request.workspaceId) !== request.workspacePath) {
			return { ok: false, error: `workspace ${request.workspaceId} does not run the pipeline` };
		}
		if (!deps.runAction) {
			return { ok: false, error: "this server runs no pipeline actions" };
		}
		try {
			return await deps.runAction(request);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};

	const sendSnapshot = async (workspaceId: string, workspacePath: string): Promise<void> => {
		if (!child) {
			return;
		}
		try {
			const [snapshot, pidPressure] = await Promise.all([
				deps.buildSnapshot(workspaceId, workspacePath),
				// An unreadable flag is no pressure, as the legacy kit's existsSync was.
				readPidPressure().then(
					(flags) => flags.pressure,
					() => false,
				),
			]);
			if (snapshot && child && pipelineWorkspaces.has(workspaceId)) {
				child.send({ type: "snapshot", snapshot: { reviewSettleMs, pidPressure, ...snapshot } });
			}
		} catch (error) {
			deps.log(
				`pipeline ${workspaceId}: could not read the workspace for the worker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	/** A snapshot of the workspace after the coalescing delay; requests meanwhile share it. */
	const scheduleSnapshot = (workspaceId: string): void => {
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
	};

	const clearSettleTimer = (key: string): void => {
		const timer = settleTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			settleTimers.delete(key);
		}
	};

	/** The snapshot sent once this session's Review has settled, counted from now (a later call restarts it). */
	const armSettleTimer = (key: string, workspaceId: string): void => {
		clearSettleTimer(key);
		if (reviewSettleMs <= 0) {
			return;
		}
		const timer = setTimeout(() => {
			settleTimers.delete(key);
			scheduleSnapshot(workspaceId);
		}, reviewSettleMs);
		timer.unref();
		settleTimers.set(key, timer);
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
			} else if (message.type === "request") {
				const { request } = message;
				const handle = deps.handleWatchdogRequest;
				void (async () => {
					try {
						let result: unknown;
						if (isPipelineActionRequest(request)) {
							const answer = await runAction(request);
							if (!answer.ok) {
								throw new Error(answer.error);
							}
							result = answer;
						} else {
							if (!handle) {
								throw new Error("this server does not carry out watchdog actions");
							}
							result = await handle(request);
						}
						started.send({ type: "response", id: message.id, ok: true, result });
					} catch (error) {
						started.send({
							type: "response",
							id: message.id,
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
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
		const nextCardActions = new Map<string, string>();
		const nextIssues = new Map<string, string>();
		const watchdogOn = config.watchdog.mode !== "off";
		for (const workspace of deps.listWorkspaces()) {
			const settings = getWorkspacePipelineSettings(config, workspace.workspaceId);
			const qa = !config.pipeline.paused && isPipelineWorkspace(settings);
			const recovery = !config.pipeline.paused && getRecoveryScope(config, settings).evaluate;
			if (workspace.workspacePath && (qa || recovery || watchdogOn)) {
				next.set(workspace.workspaceId, workspace.workspacePath);
			}
			if (workspace.workspacePath && qa) {
				nextCardActions.set(workspace.workspaceId, workspace.workspacePath);
			}
			if (workspace.workspacePath && next.has(workspace.workspaceId) && settings.issues.mode === "on") {
				nextIssues.set(workspace.workspaceId, workspace.workspacePath);
			}
		}
		const previous = pipelineWorkspaces;
		pipelineWorkspaces = next;
		cardActionWorkspaces = nextCardActions;
		issueWorkspaces = nextIssues;
		if (next.size === 0) {
			if (child) {
				deps.log(
					"pipeline worker stopped: no workspace has landing mode qa or recovery on, and the watchdog is off",
				);
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
				const reviewActivityAt = getReviewActivityAt(summary);
				lastSessionStates.set(key, { state: summary.state, reviewActivityAt });
				if (previous?.state === summary.state) {
					// A turn can end in Review with no state change (a hook's to_review on a session that never showed
					// running, e.g. input delivered to an agent without a prompt-submit hook, issue #20): its hooks move the
					// Review's clock, so it gets the settled snapshot too. Nothing else is sent for it now.
					if (summary.state === "awaiting_review" && reviewActivityAt !== previous.reviewActivityAt) {
						armSettleTimer(key, workspaceId);
					}
					return;
				}
				clearSettleTimer(key);
				if (summary.state === "awaiting_review") {
					armSettleTimer(key, workspaceId);
				}
			}
			scheduleSnapshot(workspaceId);
		},
		forgetWorkspace: (workspaceId) => {
			for (const key of [...lastSessionStates.keys()]) {
				if (key.startsWith(`${workspaceId}:`)) {
					lastSessionStates.delete(key);
				}
			}
			for (const key of [...settleTimers.keys()]) {
				if (key.startsWith(`${workspaceId}:`)) {
					clearSettleTimer(key);
				}
			}
			const timer = coalesceTimers.get(workspaceId);
			if (timer) {
				clearTimeout(timer);
				coalesceTimers.delete(workspaceId);
			}
			cardActionWorkspaces.delete(workspaceId);
			issueWorkspaces.delete(workspaceId);
			if (pipelineWorkspaces.delete(workspaceId)) {
				child?.send({ type: "forget", workspaceId });
			}
		},
		notifyLanded: (event) => {
			child?.send({ type: "landed", event });
		},
		requestSnapshot: (workspaceId) => scheduleSnapshot(workspaceId),
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
			for (const timer of settleTimers.values()) {
				clearTimeout(timer);
			}
			settleTimers.clear();
			await sweepRunning;
			stopChild();
		},
	};
}
