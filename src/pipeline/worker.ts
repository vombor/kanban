// The pipeline worker (decision 1, plan §5): a supervised child process of the Kanban server
// (`kanban pipeline worker`, started by worker-host.ts). The server sends it workspace snapshots on state-hub
// changes; the worker reads the core settings and the workspace's kit on every evaluation (so `kanban kit apply`
// or a landing-mode change needs no restart), asks the kit, and writes each new decision to the decision log.
// A pipeline fix ships as a worker restart instead of a Kanban restart, so no card's PTY dies for it.
//
// Each Review card goes through the submission stage first (snapshot, scripted checks; submission-stage.ts). The
// checks run in this process, one at a time for the whole worker (checks.ts), and their results go to the card's
// pipeline-state entry, the QA log and the decision log.
//
// Acting goes through the server: `finishTask()` sends a `finishTask` request (the Done workflow with its landing
// step) and resolves with the server's answer; features release holds through it (src/pipeline/hold.ts).
//
// A workspace is evaluated only with landing mode `qa`. Everything else (`off`, `commit`, `pr`, no entry = `off`
// on the `default` kit) is forgotten: no state file, no log, no kit question.
//
// The watchdog (src/pipeline/watchdog/) runs here too, on its own tick, over every snapshot the server sends (the
// server sends every workspace while `watchdog.mode` is not "off"). It acts through requests to the server
// (`request` → `response` over IPC), never on the board or a PTY itself.
import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeTaskTrashResponse } from "../core/api-contract";
import { type EffectiveModelConfig, readClineDefaultModel } from "../core/effective-agent";
import { createRoutingPolicy } from "../kits/policy";
import { type KitCatalog, loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { readClineProvidersFile } from "../models/cline-providers";
import { getClineProvidersSettingsPath } from "../state/kanban-home";
import { CHECKS_VERSION, type ChecksResult, type ChecksRunner, createChecksRunner, formatChecksReport } from "./checks";
import { createPipelineDecisionLog, type PipelineDecisionLog, type PipelineDecisionRecord } from "./decision-log";
import { evaluatePipelineWorkspace, isPipelineWorkspace, type PipelineWorkspaceSnapshot } from "./engine";
import { createPipelineEventBus, type PipelineEventBus } from "./events";
import { createPipelineFeatureRegistry, type PipelineFeatureActions, type PipelineFeatureRegistry } from "./features";
import { preserveTaskWork, releaseHold } from "./hold";
import { createPipelineStateStore, type PipelineStateStore } from "./pipeline-state";
import { type AppendQaLog, createQaLogAppender } from "./qa-log";
import { createSubmissionStage, type SubmissionInspector } from "./submission-stage";
import type { WatchdogActionRequest, WatchdogActionResult, WatchdogActions } from "./watchdog/actions";
import { createWatchdog, type Watchdog } from "./watchdog/watchdog";
import {
	isPipelineHostMessage,
	type PipelineFinishTaskRequest,
	type PipelineHostMessage,
	type PipelineWorkerMessage,
} from "./worker-protocol";

export interface PipelineWorkerDependencies {
	send: (message: PipelineWorkerMessage) => void;
	readConfig?: () => Promise<ParsedPipelineConfig>;
	loadCatalog?: () => Promise<KitCatalog>;
	store?: PipelineStateStore;
	decisionLog?: PipelineDecisionLog;
	bus?: PipelineEventBus;
	features?: PipelineFeatureRegistry;
	/** The submission stage (snapshot + checks). Default: the real one, with `checks`. */
	inspectSubmission?: SubmissionInspector;
	/** Factory for the checks runner; gets the result recorder. */
	createChecks?: (onResult: (result: ChecksResult) => Promise<void>) => ChecksRunner;
	appendQaLog?: AppendQaLog;
	loadAgentDefaultModels?: (config: ParsedPipelineConfig) => Promise<EffectiveModelConfig["agentDefaultModels"]>;
	/** Tags a card's work for releaseHold (preserveTaskWork in src/pipeline/hold.ts). */
	preserveWork?: (input: { workspacePath: string; taskId: string; tag: string }) => Promise<unknown>;
	/** Builds the watchdog from the worker's actions client and stores (tests inject one with fake files and agents). */
	createWatchdog?: (input: {
		actions: WatchdogActions;
		readConfig: () => Promise<ParsedPipelineConfig>;
		loadCatalog: () => Promise<KitCatalog>;
		store: PipelineStateStore;
		features: PipelineFeatureRegistry;
		loadAgentDefaultModels: (config: ParsedPipelineConfig) => Promise<EffectiveModelConfig["agentDefaultModels"]>;
		log: (message: string) => void;
	}) => Watchdog;
	/** How long a watchdog request waits for the server's answer. */
	requestTimeoutMs?: number;
	now?: () => number;
}

export interface PipelineWorker {
	handle: (message: PipelineHostMessage) => Promise<void>;
	/** Asks the server to run the Done workflow (landing included) for a card; resolves with its answer. */
	finishTask: (request: PipelineFinishTaskRequest) => Promise<RuntimeTaskTrashResponse>;
	/** Lands or discards a held card of a watched workspace (what features get as `context.releaseHold`). */
	releaseHold: PipelineFeatureActions["releaseHold"];
	/** Resolves once every queued evaluation has settled. */
	idle: () => Promise<void>;
	/** One watchdog pass (the process runner calls it every `watchdog.intervalSec`). */
	tickWatchdog: () => Promise<void>;
	/** Starts the watchdog's timer; it re-reads `watchdog.intervalSec` after every tick. */
	startWatchdog: () => void;
	close: () => void;
}

interface WorkspaceQueue {
	running: Promise<void> | null;
	pending: PipelineWorkspaceSnapshot | null;
}

async function loadDefaultAgentModels(
	config: ParsedPipelineConfig,
): Promise<EffectiveModelConfig["agentDefaultModels"]> {
	const providers = await readClineProvidersFile(getClineProvidersSettingsPath(config.config.agents.cline.dataDir));
	return providers ? { cline: readClineDefaultModel(providers) } : {};
}

function decisionKey(record: PipelineDecisionRecord): string {
	const { at: _at, ...rest } = record;
	return JSON.stringify(rest);
}

export function createPipelineWorker(deps: PipelineWorkerDependencies): PipelineWorker {
	const log = (message: string): void => deps.send({ type: "log", message });
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	const loadCatalog = deps.loadCatalog ?? (async () => await loadKitCatalog());
	const store = deps.store ?? createPipelineStateStore({ log });
	const decisionLog = deps.decisionLog ?? createPipelineDecisionLog();
	const bus = deps.bus ?? createPipelineEventBus({ log });
	const preserveWork = deps.preserveWork ?? preserveTaskWork;

	let nextRequestId = 1;
	const pendingFinishes = new Map<
		number,
		{ resolve: (result: RuntimeTaskTrashResponse) => void; reject: (error: Error) => void }
	>();
	// workspaceId → its path, from the newest snapshot (features only know the workspace id).
	const workspacePaths = new Map<string, string>();

	const finishTask = (request: PipelineFinishTaskRequest): Promise<RuntimeTaskTrashResponse> =>
		new Promise((resolve, reject) => {
			if (closed) {
				reject(new Error("the pipeline worker is shutting down"));
				return;
			}
			const requestId = nextRequestId++;
			pendingFinishes.set(requestId, { resolve, reject });
			deps.send({ type: "finishTask", requestId, request });
		});

	const actions: PipelineFeatureActions = {
		releaseHold: async (workspaceId, input) => {
			const workspacePath = workspacePaths.get(workspaceId);
			if (!workspacePath) {
				return { ok: false, error: `workspace ${workspaceId} is not watched by the pipeline` };
			}
			return await releaseHold(
				{
					store,
					finishTask: async (request) =>
						await finishTask({
							workspaceId: request.workspaceId,
							taskId: request.taskId,
							landing: request.landing,
							trigger: "hold_release",
						}),
					preserveWork: async (target) => {
						await preserveWork(target);
					},
					now,
				},
				{ ...input, workspaceId, workspacePath },
			);
		},
	};
	const features = deps.features ?? createPipelineFeatureRegistry({ bus, actions, log });
	const appendQaLog = deps.appendQaLog ?? createQaLogAppender();
	const loadAgentDefaultModels = deps.loadAgentDefaultModels ?? loadDefaultAgentModels;
	const now = deps.now ?? Date.now;

	const recordChecksResult = async (result: ChecksResult): Promise<void> => {
		const { request } = result;
		const parsed = await readConfig();
		const settings = getWorkspacePipelineSettings(parsed.config, request.workspaceId);
		const resolution = resolveWorkspaceKit(parsed.config, request.workspaceId, await loadCatalog());
		const steps = result.steps.map((step) => ({
			name: step.name,
			status: step.skipped ? "skipped" : step.ok ? "ok" : step.timedOut ? "timeout" : "fail",
			ms: step.ms ?? null,
		}));
		// The legacy checks-state fields (`snapshot`, `version`, `harness`: the checked snapshot) plus the result.
		await store.update(request.workspaceId, (state) => {
			state.cards[request.taskId] = {
				...state.cards[request.taskId],
				snapshot: request.snapshot,
				version: CHECKS_VERSION,
				harness: result.harness,
				checks: {
					verdict: result.verdict,
					at: new Date(result.finishedAt).toISOString(),
					logs: result.logsDir,
					steps,
					error: result.error,
				},
			};
			return state;
		});
		if (result.verdict !== "ERROR") {
			await appendQaLog(request.workspaceId, formatChecksReport(result));
		}
		const summary = result.error ?? steps.map((step) => `${step.name.replaceAll(" ", "_")}=${step.status}`).join(" ");
		await decisionLog.append([
			{
				at: new Date(result.finishedAt).toISOString(),
				workspaceId: request.workspaceId,
				taskId: request.taskId,
				stage: "checks",
				kit: resolution.kitName,
				landingMode: settings.landing.mode,
				shadow: settings.pipeline.shadow,
				effectiveAgent: null,
				model: null,
				role: "dev",
				answer: null,
				outcome: "acted",
				note: `checks ${result.verdict} on ${request.snapshot.slice(0, 8)}${result.harness ? " (harness problems; checked again on the next submission)" : ""}: ${summary}`,
			},
		]);
		log(`checks ${request.taskId}: ${result.verdict} (${summary})`);
	};
	const checks =
		deps.createChecks?.(recordChecksResult) ??
		createChecksRunner({
			readSettings: async () => (await readConfig()).config.pipeline.checks,
			onResult: recordChecksResult,
			log,
		});
	const submissionStage = createSubmissionStage({ checks });
	const inspectSubmission = deps.inspectSubmission ?? submissionStage.inspect;
	const requestTimeoutMs = deps.requestTimeoutMs ?? 120_000;
	let nextWatchdogRequestId = 1;
	const pendingRequests = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	const watchdogActions: WatchdogActions = {
		request: async <Request extends WatchdogActionRequest>(request: Request) => {
			const id = nextWatchdogRequestId++;
			const result = await new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pendingRequests.delete(id);
					reject(new Error(`no answer from the server to ${request.kind} within ${requestTimeoutMs} ms`));
				}, requestTimeoutMs);
				timer.unref();
				pendingRequests.set(id, { resolve, reject, timer });
				deps.send({ type: "request", id, request });
			});
			// The server answers each kind with its WatchdogActionResults entry (src/server/watchdog-actions.ts).
			return result as WatchdogActionResult<Request["kind"]>;
		},
	};
	const watchdog = (deps.createWatchdog ?? createWatchdog)({
		actions: watchdogActions,
		readConfig,
		loadCatalog,
		store,
		features,
		loadAgentDefaultModels,
		log,
	});
	let watchdogTimer: NodeJS.Timeout | null = null;
	let watchdogRunning: Promise<void> | null = null;
	const tickWatchdog = async (): Promise<void> => {
		if (closed) {
			return;
		}
		watchdogRunning ??= watchdog
			.tick()
			.catch((error: unknown) => {
				log(`watchdog tick failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				watchdogRunning = null;
			});
		await watchdogRunning;
	};

	const queues = new Map<string, WorkspaceQueue>();
	// "<workspaceId>:<taskId>:<stage>" → the last logged decision, so an unchanged one is logged once.
	const lastDecisionKeys = new Map<string, string>();
	// workspaceId → the settings/kit line last logged for it.
	const lastWatchKeys = new Map<string, string>();
	const reportedIssues = new Set<string>();
	let closed = false;

	const forget = (workspaceId: string): void => {
		features.removeWorkspace(workspaceId);
		submissionStage.forgetWorkspace(workspaceId);
		workspacePaths.delete(workspaceId);
		if (lastWatchKeys.delete(workspaceId)) {
			log(`pipeline ${workspaceId}: not watched any more`);
		}
		for (const key of [...lastDecisionKeys.keys()]) {
			if (key.startsWith(`${workspaceId}:`)) {
				lastDecisionKeys.delete(key);
			}
		}
	};

	const reportOnce = (key: string, message: string): void => {
		if (!reportedIssues.has(key)) {
			reportedIssues.add(key);
			log(message);
		}
	};

	const evaluate = async (snapshot: PipelineWorkspaceSnapshot): Promise<void> => {
		const { workspaceId } = snapshot;
		const parsed = await readConfig();
		for (const issue of parsed.issues) {
			reportOnce(`config:${issue}`, `pipeline config: ${issue}`);
		}
		const settings = getWorkspacePipelineSettings(parsed.config, workspaceId);
		if (parsed.config.pipeline.paused || !isPipelineWorkspace(settings)) {
			forget(workspaceId);
			deps.send({ type: "evaluated", workspaceId, decisions: 0, logged: 0 });
			return;
		}
		const catalog = await loadCatalog();
		for (const error of catalog.errors) {
			reportOnce(`kit:${error.path}:${error.error}`, `pipeline kits: ${error.path}: ${error.error}`);
		}
		const resolution = resolveWorkspaceKit(parsed.config, workspaceId, catalog);
		for (const issue of resolution.issues) {
			reportOnce(`ws:${workspaceId}:${issue}`, `pipeline ${workspaceId}: ${issue}`);
		}
		workspacePaths.set(workspaceId, snapshot.workspacePath);
		features.syncWorkspace(workspaceId, resolution.kit);
		const state = await store.load(workspaceId);

		const records: PipelineDecisionRecord[] = [];
		const watchKey = JSON.stringify([settings.landing.mode, settings.pipeline.shadow, resolution.kitName]);
		if (lastWatchKeys.get(workspaceId) !== watchKey) {
			lastWatchKeys.set(workspaceId, watchKey);
			records.push({
				at: new Date(now()).toISOString(),
				workspaceId,
				taskId: null,
				stage: "worker",
				kit: resolution.kitName,
				landingMode: settings.landing.mode,
				shadow: settings.pipeline.shadow,
				effectiveAgent: null,
				model: null,
				role: null,
				answer: null,
				outcome: "none",
				note: `watching: landing ${settings.landing.mode}, kit ${resolution.kitName}${settings.pipeline.shadow ? ", shadow" : ""}; acting on verdicts since ${state.since}`,
			});
		}

		const decisions = await evaluatePipelineWorkspace({
			snapshot,
			settings,
			kitName: resolution.kitName,
			policy: createRoutingPolicy(resolution.kit),
			state,
			limits: { maxFailRounds: parsed.config.pipeline.rework.maxFailRounds },
			agentDefaultModels: await loadAgentDefaultModels(parsed),
			inspectSubmission: async (input) =>
				await inspectSubmission(
					{
						workspaceId,
						workspacePath: snapshot.workspacePath,
						settings,
						kitName: resolution.kitName,
						state,
					},
					input,
				),
			now: now(),
		});
		const seen = new Set<string>();
		for (const decision of decisions) {
			const cardKey = `${workspaceId}:${decision.taskId}:${decision.stage}`;
			seen.add(cardKey);
			const key = decisionKey(decision);
			if (lastDecisionKeys.get(cardKey) !== key) {
				lastDecisionKeys.set(cardKey, key);
				records.push(decision);
			}
		}
		// A card that left Review (or lost its work) is decided again when it comes back, stage by stage.
		for (const key of [...lastDecisionKeys.keys()]) {
			if (key.startsWith(`${workspaceId}:`) && !seen.has(key)) {
				lastDecisionKeys.delete(key);
			}
		}
		if (records.length > 0) {
			await decisionLog.append(records);
		}
		deps.send({ type: "evaluated", workspaceId, decisions: decisions.length, logged: records.length });
	};

	const schedule = (snapshot: PipelineWorkspaceSnapshot): Promise<void> => {
		const queue = queues.get(snapshot.workspaceId) ?? { running: null, pending: null };
		queues.set(snapshot.workspaceId, queue);
		// One evaluation per workspace at a time; snapshots that arrive meanwhile collapse into the newest.
		queue.pending = snapshot;
		if (queue.running) {
			return queue.running;
		}
		queue.running = (async () => {
			while (queue.pending && !closed) {
				const next = queue.pending;
				queue.pending = null;
				try {
					await evaluate(next);
				} catch (error) {
					log(
						`pipeline ${next.workspaceId}: evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		})().finally(() => {
			queue.running = null;
		});
		return queue.running;
	};

	return {
		handle: async (message) => {
			if (closed) {
				return;
			}
			if (message.type === "snapshot") {
				watchdog.observe(message.snapshot);
				await schedule(message.snapshot);
			} else if (message.type === "forget") {
				watchdog.forget(message.workspaceId);
				forget(message.workspaceId);
			} else if (message.type === "landed") {
				await bus.emit("landed", message.event);
			} else if (message.type === "finishTaskResult") {
				const pending = pendingFinishes.get(message.requestId);
				pendingFinishes.delete(message.requestId);
				pending?.resolve(message.result);
			} else if (message.type === "response") {
				const pending = pendingRequests.get(message.id);
				if (pending) {
					pendingRequests.delete(message.id);
					clearTimeout(pending.timer);
					if (message.ok) {
						pending.resolve(message.result);
					} else {
						pending.reject(new Error(message.error));
					}
				}
			}
		},
		finishTask,
		releaseHold: actions.releaseHold,
		idle: async () => {
			await Promise.all([...queues.values()].map(async (queue) => await queue.running));
			await watchdogRunning;
		},
		tickWatchdog,
		startWatchdog: () => {
			if (watchdogTimer || closed) {
				return;
			}
			const schedule = async (): Promise<void> => {
				const intervalSec = (await readConfig().catch(() => null))?.config.watchdog.intervalSec ?? 60;
				if (closed) {
					return;
				}
				watchdogTimer = setTimeout(() => {
					void tickWatchdog().finally(() => void schedule());
				}, intervalSec * 1000);
				watchdogTimer.unref();
			};
			void schedule();
		},
		close: () => {
			closed = true;
			checks.close();
			for (const pending of pendingFinishes.values()) {
				pending.reject(new Error("the pipeline worker is shutting down"));
			}
			pendingFinishes.clear();
			if (watchdogTimer) {
				clearTimeout(watchdogTimer);
				watchdogTimer = null;
			}
			for (const [id, pending] of pendingRequests) {
				clearTimeout(pending.timer);
				pending.reject(new Error("the pipeline worker is shutting down"));
				pendingRequests.delete(id);
			}
			features.close();
		},
	};
}

/**
 * `kanban pipeline worker`: the child process side. Resolves (and lets the process exit) once the server
 * disconnects or says shutdown and the running evaluations have settled.
 */
export async function runPipelineWorkerProcess(): Promise<void> {
	const send = process.send?.bind(process);
	if (!send) {
		throw new Error("kanban pipeline worker runs only as a child of the Kanban server (it needs an IPC channel).");
	}
	const worker = createPipelineWorker({
		send: (message) => {
			if (process.connected) {
				send(message);
			}
		},
	});
	worker.startWatchdog();
	await new Promise<void>((resolve) => {
		const stop = (): void => {
			worker.close();
			void worker.idle().finally(() => {
				// The IPC channel is the last thing keeping the process alive.
				if (process.connected) {
					process.disconnect();
				}
				resolve();
			});
		};
		process.on("message", (message: unknown) => {
			if (!isPipelineHostMessage(message)) {
				return;
			}
			if (message.type === "shutdown") {
				stop();
				return;
			}
			void worker.handle(message);
		});
		process.on("disconnect", stop);
		send({ type: "ready", pid: process.pid });
	});
}
