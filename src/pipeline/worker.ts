// The pipeline worker (decision 1, plan §5): a supervised child process of the Kanban server
// (`kanban pipeline worker`, started by worker-host.ts). The server sends it workspace snapshots on state-hub
// changes; the worker reads the core settings and the workspace's kit on every evaluation (so `kanban kit apply`
// or a landing-mode change needs no restart), asks the kit, and writes each new decision to the decision log.
// A pipeline fix ships as a worker restart instead of a Kanban restart, so no card's PTY dies for it.
//
// Each Review card goes through the submission stage first (snapshot, scripted checks; submission-stage.ts). The
// checks run in this process, one at a time for the whole worker (checks.ts), and their results go to the card's
// pipeline state, the QA log and the decision log. The QA gate creates a card's QA card only once the checks of its
// snapshot are recorded (qa-checks-report.ts), so a recorded result re-evaluates its workspace with the newest
// snapshot, and so does the end of a QA card's checks wait (`requestWake`): neither changes the board, so no new
// snapshot would come.
//
// Acting goes through the server: `finishTask()` sends a `finishTask` request (the Done workflow with its landing
// step) and resolves with the server's answer; features release holds through it (src/pipeline/hold.ts). Outside
// shadow the QA gate (qa-gate.ts) acts on the kit's answers: it creates, starts and nudges QA cards through `action`
// requests (actions.ts), finishes them and lands a PASS through `finishTask`; then the rework stage (rework.ts) acts
// on FAILs, land conflicts and returned reworks with the kit's `onFail` answer through the same requests and
// `deliverInput`. The worker never writes the board.
//
// A workspace is evaluated only with landing mode `qa`, or by recovery alone with `pipeline.recovery.mode: "on"` and
// recovery enabled (recovery-stage.ts). Everything else (`off`, `commit`, `pr`, no entry = `off` on the `default`
// kit, recovery in its default `report` mode) is forgotten: no state file, no log, no kit question. Recovery acts
// through the same requests: the watchdog's `deliverInput` / `interrupt` and the card action `resumeTask`.
//
// The watchdog (src/pipeline/watchdog/) runs here too, on its own tick, over every snapshot the server sends (the
// server sends every workspace while `watchdog.mode` is not "off"). It acts through requests to the server
// (`request` → `response` over IPC), never on the board or a PTY itself.
import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeTaskTrashResponse } from "../core/api-contract";
import type { EffectiveModelConfig } from "../core/effective-agent";
import { createIssueSyncJobs, takeWorkspaceIssueWakeNotes } from "../issues/issue-job";
import type { IssueSyncDependencies } from "../issues/issue-sync";
import { createRoutingPolicy } from "../kits/policy";
import { type KitCatalog, loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { getWorkspaceRoutingVetting } from "../kits/routing-vetting";
import { registerTeamKitFeatures } from "../kits/team/features";
import { readAgentDefaultModels } from "../models/cline-providers";
import { getAgentClearCommand, readAgentSessionSize } from "../terminal/orchestrator-agents";
import type { PipelineActionResult, PipelineActions } from "./actions";
import {
	CHECKS_VERSION,
	type ChecksResult,
	type ChecksRunner,
	createChecksRunner,
	formatChecksReport,
	toStoredChecksResult,
} from "./checks";
import { createPipelineDecisionLog, type PipelineDecisionLog, type PipelineDecisionRecord } from "./decision-log";
import { EMPTY_DIFF_FIELD } from "./empty-diff";
import {
	evaluatePipelineWorkspace,
	getRecoveryScope,
	isPipelineWorkspace,
	type PipelineWorkspaceSnapshot,
} from "./engine";
import { createPipelineEventBus, type PipelineEventBus } from "./events";
import {
	createPipelineFeatureRegistry,
	type PipelineFeatureActions,
	type PipelineFeaturePassInput,
	type PipelineFeatureRegistry,
} from "./features";
import { clearHold, preserveTaskWork, releaseHold } from "./hold";
import { createPipelineStateStore, type PipelineStateStore } from "./pipeline-state";
import { createQaGate, type QaGate } from "./qa-gate";
import { type AppendQaLog, createQaLogAppender } from "./qa-log";
import { createQaPreviewController } from "./qa-preview";
import { readQaVerdictFile } from "./qa-verdict";
import { createQaRunErrorReader, createQaSilentStallReader, createWorkerRecoveryStage } from "./recovery-runtime";
import type { RecoveryStage, RecoveryStageDependencies } from "./recovery-stage";
import { readResubmitRequest } from "./resubmit";
import { createReworkStage, type ReworkStage } from "./rework";
import { stopScratchProcesses } from "./scratch-processes";
import { createSubmissionStage, type SubmissionInspector } from "./submission-stage";
import type { WatchdogActionRequest, WatchdogActionResult, WatchdogActions } from "./watchdog/actions";
import { createWatchdog, type Watchdog, type WatchdogDependencies } from "./watchdog/watchdog";
import {
	isPipelineHostMessage,
	type PipelineFinishTaskRequest,
	type PipelineHostMessage,
	type PipelineServerRequest,
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
		coreJobs: WatchdogDependencies["coreJobs"];
		takeWakeNotes: WatchdogDependencies["takeWakeNotes"];
		log: (message: string) => void;
	}) => Watchdog;
	/** The issue import's job dependencies (tests inject a fake GitHub). */
	issueSync?: IssueSyncDependencies;
	/** How long a watchdog request waits for the server's answer. */
	requestTimeoutMs?: number;
	/** The QA gate's card actions. Default: `request`s to the server over IPC. */
	qaActions?: PipelineActions;
	qaGate?: QaGate;
	/** The recovery stage, given the worker's request-backed actions. Default: the real one (recovery-runtime.ts). */
	createRecovery?: (act: RecoveryStageDependencies["act"]) => RecoveryStage;
	reworkStage?: ReworkStage;
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
	return await readAgentDefaultModels(config.config.agents.cline.dataDir);
}

function createDefaultFeatureRegistry(
	deps: Parameters<typeof createPipelineFeatureRegistry>[0],
): PipelineFeatureRegistry {
	const registry = createPipelineFeatureRegistry(deps);
	registerTeamKitFeatures(registry);
	return registry;
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
		appendQaLog: async (workspaceId, text) => {
			await appendQaLog(workspaceId, text);
		},
		unhold: async (workspaceId, input) =>
			(await clearHold(store, { workspaceId, ...input, by: "pipeline", now: now() })) !== null,
	};
	const features = deps.features ?? createDefaultFeatureRegistry({ bus, actions, log });
	const appendQaLog = deps.appendQaLog ?? createQaLogAppender();
	const loadAgentDefaultModels = deps.loadAgentDefaultModels ?? loadDefaultAgentModels;
	const now = deps.now ?? Date.now;

	const recordChecksResult = async (result: ChecksResult): Promise<void> => {
		const { request } = result;
		const parsed = await readConfig();
		const settings = getWorkspacePipelineSettings(parsed.config, request.workspaceId);
		const resolution = resolveWorkspaceKit(parsed.config, request.workspaceId, await loadCatalog());
		const stored = toStoredChecksResult(result);
		const { steps } = stored;
		// The legacy checks-state fields (`snapshot`, `version`, `harness`: the checked snapshot) plus the result.
		await store.update(request.workspaceId, (state) => {
			state.cards[request.taskId] = {
				...state.cards[request.taskId],
				snapshot: request.snapshot,
				version: CHECKS_VERSION,
				harness: result.harness,
				checks: stored,
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
		reevaluate(request.workspaceId);
	};
	const checks =
		deps.createChecks?.(recordChecksResult) ??
		createChecksRunner({
			readSettings: async () => (await readConfig()).config.pipeline.checks,
			onResult: recordChecksResult,
			log,
		});
	const submissionStage = createSubmissionStage({
		checks,
		// The watchdog reports an empty-diff Review from this record (stalls.ts, issue #14).
		recordEmptyDiff: async (workspaceId, taskId, emptyDiff) => {
			await store.update(workspaceId, (state) => {
				const { [EMPTY_DIFF_FIELD]: _previous, ...entry } = state.cards[taskId] ?? {};
				state.cards[taskId] = emptyDiff ? { ...entry, [EMPTY_DIFF_FIELD]: emptyDiff } : entry;
				return state;
			});
		},
		now,
	});
	const inspectSubmission = deps.inspectSubmission ?? submissionStage.inspect;
	const requestTimeoutMs = deps.requestTimeoutMs ?? 120_000;
	let nextServerRequestId = 1;
	const pendingRequests = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	const sendRequest = async (request: PipelineServerRequest): Promise<unknown> => {
		if (closed) {
			throw new Error("the pipeline worker is shutting down");
		}
		const id = nextServerRequestId++;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error(`no answer from the server to ${request.kind} within ${requestTimeoutMs} ms`));
			}, requestTimeoutMs);
			timer.unref();
			pendingRequests.set(id, { resolve, reject, timer });
			deps.send({ type: "request", id, request });
		});
	};
	const watchdogActions: WatchdogActions = {
		request: async <Request extends WatchdogActionRequest>(request: Request) =>
			// The server answers each kind with its WatchdogActionResults entry (src/server/watchdog-actions.ts).
			(await sendRequest(request)) as WatchdogActionResult<Request["kind"]>,
	};
	// The QA gate's card actions go over the same request channel; the host refuses them for other workspaces.
	const gateActions: PipelineActions = deps.qaActions ?? {
		run: async (request) => {
			try {
				await sendRequest(request);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
	const deliverInput = async ({
		workspaceId,
		taskId,
		text,
	}: {
		workspaceId: string;
		taskId: string;
		text: string;
	}): Promise<{ ok: boolean; error?: string }> => {
		try {
			const delivered = await watchdogActions.request({ kind: "deliverInput", workspaceId, taskId, text });
			return delivered.ok ? { ok: true } : { ok: false, error: delivered.error ?? delivered.status };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	const qaGate =
		deps.qaGate ??
		createQaGate({
			actions: gateActions,
			deliverInput,
			finishTask,
			appendQaLog,
			store,
			bus,
			preview: createQaPreviewController({ log }),
			readVerdict: readQaVerdictFile,
			readRunError: createQaRunErrorReader(),
			readSilentStall: createQaSilentStallReader(),
			stopScratchProcesses: async (dirs) => await stopScratchProcesses(dirs, log),
			log,
		});
	// Recovery's actions over the same request channel; resuming needs the workspace path of the newest snapshot.
	const recoveryAct: RecoveryStageDependencies["act"] = async (workspaceId, action) => {
		try {
			if (action.kind === "deliver") {
				const delivered = await watchdogActions.request({
					kind: "deliverInput",
					workspaceId,
					taskId: action.taskId,
					text: action.text,
				});
				return {
					ok: delivered.ok,
					status: delivered.status,
					evidence: delivered.evidence,
					...(delivered.error ? { error: delivered.error } : {}),
				};
			}
			if (action.kind === "input") {
				const sent = await watchdogActions.request({ kind: "interrupt", workspaceId, taskId: action.taskId });
				return { ok: sent.ok, status: sent.ok ? "sent" : "failed", ...(sent.error ? { error: sent.error } : {}) };
			}
			const workspacePath = workspacePaths.get(workspaceId);
			if (!workspacePath) {
				return { ok: false, error: `workspace ${workspaceId} is not watched by the pipeline` };
			}
			const resumed = await gateActions.run({
				kind: "resumeTask",
				workspaceId,
				workspacePath,
				taskId: action.taskId,
				prompt: action.prompt,
				agentId: action.agentId,
				continueConversation: action.continueConversation,
			});
			return resumed.ok ? { ok: true, status: "started" } : { ok: false, error: resumed.error };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	const recovery =
		deps.createRecovery?.(recoveryAct) ??
		createWorkerRecoveryStage({ store, decisionLog, act: recoveryAct, log, now });
	const reworkStage =
		deps.reworkStage ??
		createReworkStage({
			actions: gateActions,
			deliverInput,
			store,
			bus,
			appendQaLog,
			preserveWork,
			readSessionSize: readAgentSessionSize,
			getClearCommand: getAgentClearCommand,
			runoffGroups: features.runoffGroups,
			finishTask,
			log,
		});
	const watchdog = (deps.createWatchdog ?? createWatchdog)({
		actions: watchdogActions,
		readConfig,
		loadCatalog,
		store,
		features,
		loadAgentDefaultModels,
		coreJobs: createIssueSyncJobs({
			request: async (request) => (await sendRequest(request)) as PipelineActionResult,
			sync: deps.issueSync,
		}),
		takeWakeNotes: takeWorkspaceIssueWakeNotes,
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
	// workspaceId → the newest snapshot the server sent, for evaluations nothing on the board triggers.
	const lastSnapshots = new Map<string, PipelineWorkspaceSnapshot>();
	// workspaceId → the earliest wake the QA gate asked for.
	const wakes = new Map<string, { at: number; timer: NodeJS.Timeout }>();
	// "<workspaceId>:<taskId>:<stage>" → the last logged decision, so an unchanged one is logged once.
	const lastDecisionKeys = new Map<string, string>();
	// workspaceId → the settings/kit line last logged for it.
	const lastWatchKeys = new Map<string, string>();
	// "<workspaceId>:<taskId>" → the card's last `kanban task resubmit` request this worker has acted on.
	const lastResubmits = new Map<string, string>();
	const reportedIssues = new Set<string>();
	let closed = false;

	const clearWake = (workspaceId: string): void => {
		const wake = wakes.get(workspaceId);
		if (wake) {
			clearTimeout(wake.timer);
			wakes.delete(workspaceId);
		}
	};

	const forget = (workspaceId: string): void => {
		clearWake(workspaceId);
		features.removeWorkspace(workspaceId);
		submissionStage.forgetWorkspace(workspaceId);
		workspacePaths.delete(workspaceId);
		qaGate.forget(workspaceId);
		wakeSlotWaiters();
		recovery.forget(workspaceId);
		if (lastWatchKeys.delete(workspaceId)) {
			log(`pipeline ${workspaceId}: not watched any more`);
		}
		for (const map of [lastDecisionKeys, lastResubmits]) {
			for (const key of [...map.keys()]) {
				if (key.startsWith(`${workspaceId}:`)) {
					map.delete(key);
				}
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
		const pipelineOn = isPipelineWorkspace(settings);
		const recoveryScope = getRecoveryScope(parsed.config, settings);
		if (parsed.config.pipeline.paused || (!pipelineOn && !recoveryScope.evaluate)) {
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
		const recoveryMode = recoveryScope.evaluate ? parsed.config.pipeline.recovery.mode : "off";
		const watchKey = JSON.stringify([
			settings.landing.mode,
			settings.pipeline.shadow,
			resolution.kitName,
			recoveryMode,
		]);
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
				note: `watching: landing ${settings.landing.mode}, kit ${resolution.kitName}${settings.pipeline.shadow ? ", shadow" : ""}, recovery ${recoveryMode}${recoveryScope.evaluate && !recoveryScope.act ? " (report only)" : ""}; acting on verdicts since ${state.since}`,
			});
		}

		const policy = createRoutingPolicy(resolution.kit, getWorkspaceRoutingVetting(parsed.config, workspaceId));
		const agentDefaultModels = await loadAgentDefaultModels(parsed);
		const shadow = settings.pipeline.shadow;
		const recoveryDecisions = await recovery.evaluate({
			snapshot,
			settings,
			config: parsed.config,
			kitName: resolution.kitName,
			state,
			agentDefaultModels,
			// The rework loop below carries out an outage takeover only here.
			takeoverPolicy: pipelineOn && !shadow ? policy : null,
		});
		// Recovery runs first and may have marked cards (an orphan, a hold, a turn it resent) that the submission stage
		// and the QA gate must skip in this same evaluation, so the gate reads the state as recovery left it, on a
		// clock taken after recovery acted.
		const gateState = recoveryScope.act ? await store.load(workspaceId) : state;
		const gateContext = {
			requestWake: (at: number) => requestWake(workspaceId, at),
			snapshot,
			settings,
			qa: parsed.config.pipeline.qa,
			kit: resolution.kit,
			kitName: resolution.kitName,
			policy,
			featureOnPass: async (input: PipelineFeaturePassInput) => await features.answerOnPass(workspaceId, input),
			agentDefaultModels,
			providerCapacity: parsed.config.models.providerCapacity,
			hungMs: parsed.config.pipeline.recovery.hungMin * 60_000,
			now: now(),
		};
		// A workspace watched only for recovery (landing off/commit/pr) gets no QA-gate decisions.
		const gateDecisions = !pipelineOn
			? []
			: await evaluatePipelineWorkspace({
					snapshot,
					settings,
					kitName: resolution.kitName,
					policy,
					state: gateState,
					limits: { maxFailRounds: parsed.config.pipeline.rework.maxFailRounds },
					recoveryNudgeCheckMs: parsed.config.pipeline.recovery.nudgeCheckSec * 1000,
					restartRecoveryActs: recoveryScope.act,
					agentDefaultModels,
					inspectSubmission: async (input) =>
						await inspectSubmission(
							{
								workspaceId,
								workspacePath: snapshot.workspacePath,
								settings,
								kitName: resolution.kitName,
								projectChecks: resolution.kit.checks,
								state: gateState,
							},
							input,
						),
					submitQa: shadow ? undefined : async (input) => await qaGate.submit({ context: gateContext, ...input }),
					now: gateContext.now,
				});
		const decisions = [...gateDecisions, ...recoveryDecisions];
		// A card resubmitted since the last evaluation has its decisions logged even where they repeat earlier ones, so
		// the decision log says what the request led to (issue #20: 59d13's "already has QA card" after its resubmit was
		// the line logged at 09:12, so nothing showed it).
		for (const [taskId, entry] of Object.entries(gateState.cards)) {
			const requestedAt = readResubmitRequest(entry)?.at;
			const cardKey = `${workspaceId}:${taskId}`;
			if (requestedAt && lastResubmits.get(cardKey) !== requestedAt) {
				lastResubmits.set(cardKey, requestedAt);
				for (const key of [...lastDecisionKeys.keys()]) {
					if (key.startsWith(`${cardKey}:`)) {
						lastDecisionKeys.delete(key);
					}
				}
			}
		}
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
		// QA card starts and ingests, reworks and escalations are events, logged each time. A shadow workspace acts
		// on nothing.
		if (!shadow && pipelineOn) {
			records.push(...(await qaGate.tick({ ...gateContext, now: now() })));
			wakeSlotWaiters();
			records.push(
				...(await reworkStage.tick({
					snapshot,
					settings,
					rework: parsed.config.pipeline.rework,
					kitName: resolution.kitName,
					policy,
					agentDefaultModels,
					clineDataDir: parsed.config.agents.cline.dataDir,
					recoveryNudgeCheckMs: parsed.config.pipeline.recovery.nudgeCheckSec * 1000,
					now: now(),
				})),
			);
			// Features acting on held cards (the team kit's runoffs) see the state the QA gate and the rework stage just wrote.
			await features.tick(workspaceId, { snapshot, state: await store.load(workspaceId), now: now() });
		} else {
			// No QA here, but its In Progress cards still hold their local provider for other projects' QA cards.
			qaGate.observe?.({ snapshot, agentDefaultModels });
			wakeSlotWaiters();
		}
		if (records.length > 0) {
			await decisionLog.append(records);
		}
		deps.send({ type: "evaluated", workspaceId, decisions: decisions.length, logged: records.length });
	};

	/** Workspaces whose queued QA cards wait for a machine-wide slot that was just freed elsewhere: evaluated again. */
	function wakeSlotWaiters(): void {
		for (const workspaceId of qaGate.takeSlotWakes?.() ?? []) {
			reevaluate(workspaceId);
		}
	}

	/** Evaluates the workspace again with its newest snapshot, if it is still watched. */
	function reevaluate(workspaceId: string): void {
		const snapshot = lastSnapshots.get(workspaceId);
		if (snapshot && !closed) {
			void schedule(snapshot);
		}
	}

	function requestWake(workspaceId: string, at: number): void {
		const existing = wakes.get(workspaceId);
		if (closed || (existing && existing.at <= at)) {
			return;
		}
		clearWake(workspaceId);
		const timer = setTimeout(
			() => {
				wakes.delete(workspaceId);
				reevaluate(workspaceId);
			},
			Math.max(0, at - now()),
		);
		timer.unref();
		wakes.set(workspaceId, { at, timer });
	}

	function schedule(snapshot: PipelineWorkspaceSnapshot): Promise<void> {
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
	}

	return {
		handle: async (message) => {
			if (closed) {
				return;
			}
			if (message.type === "snapshot") {
				lastSnapshots.set(message.snapshot.workspaceId, message.snapshot);
				watchdog.observe(message.snapshot);
				await schedule(message.snapshot);
			} else if (message.type === "forget") {
				lastSnapshots.delete(message.workspaceId);
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
			// An evaluation may start another workspace's (a QA slot it freed): wait until none runs.
			while ([...queues.values()].some((queue) => queue.running)) {
				await Promise.all([...queues.values()].map(async (queue) => await queue.running));
			}
			await watchdogRunning;
			await recovery.idle();
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
			for (const workspaceId of [...wakes.keys()]) {
				clearWake(workspaceId);
			}
			checks.close();
			recovery.close();
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
