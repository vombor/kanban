// The pipeline worker (decision 1, plan §5): a supervised child process of the Kanban server
// (`kanban pipeline worker`, started by worker-host.ts). The server sends it workspace snapshots on state-hub
// changes; the worker reads the core settings and the workspace's kit on every evaluation (so `kanban kit apply`
// or a landing-mode change needs no restart), asks the kit, and writes each new decision to the decision log.
// A pipeline fix ships as a worker restart instead of a Kanban restart, so no card's PTY dies for it.
//
// A workspace is evaluated only with landing mode `qa`. Everything else (`off`, `commit`, `pr`, no entry = `off`
// on the `default` kit) is forgotten: no state file, no log, no kit question.
import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardCard } from "../core/api-contract";
import { type EffectiveModelConfig, readClineDefaultModel } from "../core/effective-agent";
import { createRoutingPolicy } from "../kits/policy";
import { type KitCatalog, loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { readClineProvidersFile } from "../models/cline-providers";
import { getClineProvidersSettingsPath } from "../state/kanban-home";
import { createPipelineDecisionLog, type PipelineDecisionLog, type PipelineDecisionRecord } from "./decision-log";
import { evaluatePipelineWorkspace, isPipelineWorkspace, type PipelineWorkspaceSnapshot } from "./engine";
import { createPipelineEventBus, type PipelineEventBus } from "./events";
import { createPipelineFeatureRegistry, type PipelineFeatureRegistry } from "./features";
import { createPipelineStateStore, type PipelineStateStore } from "./pipeline-state";
import { probeTaskHasWork } from "./work-probe";
import { isPipelineHostMessage, type PipelineHostMessage, type PipelineWorkerMessage } from "./worker-protocol";

export interface PipelineWorkerDependencies {
	send: (message: PipelineWorkerMessage) => void;
	readConfig?: () => Promise<ParsedPipelineConfig>;
	loadCatalog?: () => Promise<KitCatalog>;
	store?: PipelineStateStore;
	decisionLog?: PipelineDecisionLog;
	bus?: PipelineEventBus;
	features?: PipelineFeatureRegistry;
	hasWork?: (workspacePath: string, card: RuntimeBoardCard) => Promise<boolean>;
	loadAgentDefaultModels?: (config: ParsedPipelineConfig) => Promise<EffectiveModelConfig["agentDefaultModels"]>;
	now?: () => number;
}

export interface PipelineWorker {
	handle: (message: PipelineHostMessage) => Promise<void>;
	/** Resolves once every queued evaluation has settled. */
	idle: () => Promise<void>;
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
	const features = deps.features ?? createPipelineFeatureRegistry({ bus, log });
	const hasWork = deps.hasWork ?? probeTaskHasWork;
	const loadAgentDefaultModels = deps.loadAgentDefaultModels ?? loadDefaultAgentModels;
	const now = deps.now ?? Date.now;

	const queues = new Map<string, WorkspaceQueue>();
	// "<workspaceId>:<taskId>" → the last logged decision, so an unchanged answer is logged once.
	const lastDecisionKeys = new Map<string, string>();
	// workspaceId → the settings/kit line last logged for it.
	const lastWatchKeys = new Map<string, string>();
	const reportedIssues = new Set<string>();
	let closed = false;

	const forget = (workspaceId: string): void => {
		features.removeWorkspace(workspaceId);
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
			hasWork: async (card) => await hasWork(snapshot.workspacePath, card),
			now: now(),
		});
		const seen = new Set<string>();
		for (const decision of decisions) {
			const cardKey = `${workspaceId}:${decision.taskId}`;
			seen.add(cardKey);
			const key = decisionKey(decision);
			if (lastDecisionKeys.get(cardKey) !== key) {
				lastDecisionKeys.set(cardKey, key);
				records.push(decision);
			}
		}
		// A card that left Review (or lost its work) is decided again when it comes back.
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
				await schedule(message.snapshot);
			} else if (message.type === "forget") {
				forget(message.workspaceId);
			}
		},
		idle: async () => {
			await Promise.all([...queues.values()].map(async (queue) => await queue.running));
		},
		close: () => {
			closed = true;
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
