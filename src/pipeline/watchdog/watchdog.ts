// The watchdog (was the legacy kit's review-watch, plan §1.1): an LLM-free tick every `watchdog.intervalSec` in the
// pipeline worker. It fixes what needs no judgment itself (one "continue" for a dead session, the hourly prune of old
// Done cards, the kit features' jobs), writes what needs a decision to ATTENTION.md, and wakes the orchestrator (the
// agent selected in Kanban settings) only when there is something for it to do, so no tokens go on status checks.
//
// `watchdog.mode`:
//   off    (default) nothing runs; the legacy kit's review-watch still owns this on the pod.
//   report every decision goes to data/<ws>/watchdog-decisions.jsonl and nothing is acted on: no ATTENTION.md, no
//          wake, no typed input, no prune, no flag files, no jobs. For the cutover's shadow comparison.
//   on     acts. `kanban doctor` fails "on" while review-watch runs (one owner).
//
// What runs where:
//   - every registered workspace: stuck-on-prompt detection (a trust/startup dialog or a permission answer nobody
//     sees; the kanban board's cards sat on the trust dialog for an hour on 10/06, unseen, because it wasn't a kit
//     project) and `kanban orchestrator wake` requests;
//   - workspaces the pipeline runs on (landing mode `qa`): also stalls, escalations, PID pressure, pipeline idle, the
//     orchestrator plan's open steps, prune-done and the feature jobs. A workspace on the `default` kit with landing
//     `off` gets nothing else, as the legacy kit watched only its configured projects.
//
// Ported from archive/devteam-kit:services/review-watch.mjs@6da71597 (tick, finishTick, triage, pruneDone) and kit
// main 00514f2 (wakeTarget: one orchestrator for every workspace, following Kanban's selected agent).
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
	getWorkspacePipelineSettings,
	type ParsedPipelineConfig,
	type WatchdogMode,
} from "../../config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardCard, RuntimeBoardColumnId } from "../../core/api-contract";
import type { EffectiveModelConfig } from "../../core/effective-agent";
import { createHomeAgentSessionId } from "../../core/home-agent-session";
import { createRoutingPolicy, type RoutingPolicy } from "../../kits/policy";
import { type KitCatalog, resolveWorkspaceKit } from "../../kits/resolve-kit";
import {
	getOrchestratorLockPath,
	getPidPressureFlagPaths,
	getPipelineDecisionLogPath,
	getWatchdogWorkspacePaths,
	type WatchdogWorkspacePaths,
} from "../../state/kanban-home";
import {
	agentHooksOnPromptSubmit,
	getAgentLabel,
	hasHeadlessOrchestratorRunner,
	isAgentWorkspaceTrusted,
} from "../../terminal/orchestrator-agents";
import { createWorkspaceJsonLinesLog, type WorkspaceJsonLinesLog } from "../decision-log";
import {
	isPipelineCandidate,
	isPipelineWorkspace,
	type PipelineSessionView,
	type PipelineWorkspaceSnapshot,
	readCardHistory,
	toEffectiveCard,
} from "../engine";
import type { PipelineFeatureJob, PipelineFeatureRegistry } from "../features";
import type { PipelineStateStore } from "../pipeline-state";
import type { WatchdogActions } from "./actions";
import {
	isHandedOver,
	PID_PRESSURE_ITEM_MARKER,
	PIPELINE_IDLE_ITEM_MARKER,
	planHasOpenSteps,
	readPlanHeldIds,
	readTriageVerdict,
	readUserItemIds,
	renderAttention,
} from "./attention";
import {
	appendOrchestratorQueue,
	probeModelWithCli,
	readLiveLockPid,
	spawnOrchestratorRunProcess,
} from "./headless-run";
import {
	formatPidPressureItem,
	getPidPressureLevel,
	type PidPressureLevel,
	type PidUsage,
	readCgroupPidUsage,
} from "./pid-pressure";
import { findPromptWaits } from "./prompt-watch";
import {
	CONTINUE_TEXT,
	detectPipelineIdle,
	detectStalls,
	isBoardBusy,
	readEscalation,
	resolveWatchdogCardRole,
	type WatchdogCardRole,
} from "./stalls";
import { buildWakeText, isOrchestratorSessionLive, type WakeOutcome, wakeKey, wakeOrchestrator } from "./wake";
import { checkWakeRequests, readWakeRequests, updateWakeRequests } from "./wake-requests";
import { loadWatchdogState, saveWatchdogState, type WatchdogWorkspaceState } from "./watchdog-state";
import { readCalibrationRunIds } from "./workspace-data";

const MIN = 60_000;
/** Prune-done runs about once an hour per workspace (archive/devteam-kit:services/review-watch.mjs PRUNE_EVERY). */
const PRUNE_EVERY_MIN = 60;
/** The PID-pressure process sweep runs at most this often while pressure lasts. */
const PRESSURE_SWEEP_EVERY_MS = 15 * MIN;
/** An unchanged decision is logged again after this long, so the log shows it still holds. */
const DECISION_RELOG_MS = 60 * MIN;
/** A session or headless run the watchdog just started counts as live until the next snapshot shows it. */
const JUST_STARTED_MS = 2 * MIN;

export type WatchdogDecisionKind =
	| "stall"
	| "continue"
	| "attention"
	| "prompt"
	| "pid"
	| "pause"
	| "wake"
	| "wake-request"
	| "job"
	| "error";

export interface WatchdogDecisionRecord {
	at: string;
	workspaceId: string;
	taskId: string | null;
	kind: WatchdogDecisionKind;
	mode: WatchdogMode;
	/** `acted`: done (mode on); `report`: would be done (mode report); `failed`; `skipped`: nothing to do. */
	outcome: "acted" | "report" | "failed" | "skipped";
	note: string;
}

export interface WatchdogDependencies {
	actions: WatchdogActions;
	readConfig: () => Promise<ParsedPipelineConfig>;
	loadCatalog: () => Promise<KitCatalog>;
	store: PipelineStateStore;
	features: PipelineFeatureRegistry;
	loadAgentDefaultModels?: (config: ParsedPipelineConfig) => Promise<EffectiveModelConfig["agentDefaultModels"]>;
	getPaths?: (workspaceId: string) => WatchdogWorkspacePaths;
	getPidFlagPaths?: () => { pressure: string; brownout: string };
	decisionLog?: WorkspaceJsonLinesLog<WatchdogDecisionRecord>;
	readPidUsage?: () => Promise<PidUsage | null>;
	headlessPid?: (workspaceId: string) => Promise<number>;
	startHeadlessRun?: (input: {
		workspaceId: string;
		projectPath: string;
		agentId: RuntimeAgentId;
		timeoutMin: number;
		liveSessionMin: number;
	}) => { ok: boolean; error?: string };
	probeModel?: (provider: string, model: string) => Promise<boolean>;
	isTrusted?: (agentId: RuntimeAgentId, directory: string) => Promise<boolean | null>;
	hooksOnPromptSubmit?: (agentId: RuntimeAgentId) => boolean;
	hasHeadlessRunner?: (agentId: RuntimeAgentId) => boolean;
	now?: () => number;
	log: (message: string) => void;
}

export interface Watchdog {
	observe: (snapshot: PipelineWorkspaceSnapshot) => void;
	forget: (workspaceId: string) => void;
	/** One pass over every observed workspace. */
	tick: () => Promise<void>;
}

interface TickContext {
	parsed: ParsedPipelineConfig;
	mode: WatchdogMode;
	act: boolean;
	now: number;
	pidUsage: PidUsage | null;
	pidLevel: PidPressureLevel;
	pressureSweep: { zombies: number; terminated: number } | null;
	agentDefaultModels: EffectiveModelConfig["agentDefaultModels"];
}

async function readText(path: string): Promise<string> {
	return await readFile(path, "utf8").catch(() => "");
}

function listCards(
	snapshot: PipelineWorkspaceSnapshot,
): Array<{ column: RuntimeBoardColumnId; card: RuntimeBoardCard }> {
	return snapshot.board.columns.flatMap((column) => column.cards.map((card) => ({ column: column.id, card })));
}

export function createWatchdog(deps: WatchdogDependencies): Watchdog {
	const now = deps.now ?? Date.now;
	const getPaths = deps.getPaths ?? ((workspaceId: string) => getWatchdogWorkspacePaths(workspaceId));
	const getPidFlagPaths = deps.getPidFlagPaths ?? (() => getPidPressureFlagPaths());
	const decisionLog =
		deps.decisionLog ??
		createWorkspaceJsonLinesLog<WatchdogDecisionRecord>({
			getLogPath: (workspaceId) => getPaths(workspaceId).decisions,
		});
	const readPidUsage = deps.readPidUsage ?? (async () => await readCgroupPidUsage());
	const headlessPid =
		deps.headlessPid ?? (async (workspaceId: string) => await readLiveLockPid(getOrchestratorLockPath(workspaceId)));
	const startHeadlessRun = deps.startHeadlessRun ?? spawnOrchestratorRunProcess;
	const probeModel = deps.probeModel ?? probeModelWithCli;
	const isTrusted = deps.isTrusted ?? isAgentWorkspaceTrusted;
	const hooksOnPromptSubmit = deps.hooksOnPromptSubmit ?? agentHooksOnPromptSubmit;
	const hasHeadlessRunner = deps.hasHeadlessRunner ?? hasHeadlessOrchestratorRunner;

	const snapshots = new Map<string, PipelineWorkspaceSnapshot>();
	const states = new Map<string, WatchdogWorkspaceState>();
	// decision key → when it was last logged.
	const loggedDecisions = new Map<string, number>();
	// Orchestrator sessions / headless runs started this worker life: target key → when.
	const justStarted = new Map<string, number>();
	let lastPressureSweepAt = 0;
	let lastPressureSweep: { zombies: number; terminated: number } | null = null;
	let pidFlagsSet = false;

	const loadState = async (workspaceId: string): Promise<WatchdogWorkspaceState> => {
		const cached = states.get(workspaceId);
		if (cached) {
			return cached;
		}
		const loaded = await loadWatchdogState(getPaths(workspaceId).state);
		states.set(workspaceId, loaded);
		return loaded;
	};

	const record = (
		records: WatchdogDecisionRecord[],
		context: TickContext,
		entry: Omit<WatchdogDecisionRecord, "at" | "mode">,
	): void => {
		const key = `${entry.workspaceId}|${entry.kind}|${entry.taskId ?? ""}|${entry.outcome}|${wakeKey(entry.note)}`;
		const last = loggedDecisions.get(key);
		if (last !== undefined && context.now - last < DECISION_RELOG_MS) {
			return;
		}
		loggedDecisions.set(key, context.now);
		records.push({ at: new Date(context.now).toISOString(), mode: context.mode, ...entry });
	};

	const outcomeOf = (context: TickContext, ok = true): WatchdogDecisionRecord["outcome"] =>
		!context.act ? "report" : ok ? "acted" : "failed";

	const updatePidFlags = async (context: TickContext): Promise<void> => {
		if (!context.act) {
			return;
		}
		const flags = getPidFlagPaths();
		const usage = context.pidUsage;
		if (context.pidLevel === "none") {
			if (pidFlagsSet) {
				await rm(flags.pressure, { force: true });
				await rm(flags.brownout, { force: true });
				pidFlagsSet = false;
				deps.log(`watchdog: PID pressure cleared${usage ? ` (${usage.current}/${usage.max})` : ""}`);
			}
			return;
		}
		const line = usage ? `${usage.current}/${usage.max}\n` : "\n";
		await mkdir(dirname(flags.pressure), { recursive: true });
		await writeFile(flags.pressure, line, "utf8");
		if (context.pidLevel === "brownout") {
			await writeFile(flags.brownout, line, "utf8");
		} else {
			await rm(flags.brownout, { force: true });
		}
		pidFlagsSet = true;
	};

	const resolvePolicy = async (
		parsed: ParsedPipelineConfig,
		workspaceId: string,
	): Promise<{ policy: RoutingPolicy; kitName: string }> => {
		const resolution = resolveWorkspaceKit(parsed.config, workspaceId, await deps.loadCatalog());
		return { policy: createRoutingPolicy(resolution.kit), kitName: resolution.kitName };
	};

	const runJob = async (
		job: PipelineFeatureJob,
		input: {
			workspaceId: string;
			state: WatchdogWorkspaceState;
			context: TickContext;
			records: WatchdogDecisionRecord[];
		},
	): Promise<void> => {
		const last = input.state.jobs[job.name] ? Date.parse(input.state.jobs[job.name] ?? "") : 0;
		if (input.context.now - last < job.everyMin * MIN) {
			return;
		}
		if (!input.context.act) {
			record(input.records, input.context, {
				workspaceId: input.workspaceId,
				taskId: null,
				kind: "job",
				outcome: "report",
				note: `job ${job.name} is due (every ${job.everyMin} min)`,
			});
			return;
		}
		input.state.jobs[job.name] = new Date(input.context.now).toISOString();
		try {
			const summary = await job.run();
			record(input.records, input.context, {
				workspaceId: input.workspaceId,
				taskId: null,
				kind: "job",
				outcome: "acted",
				note: `job ${job.name}: ${summary ?? "done"}`,
			});
		} catch (error) {
			record(input.records, input.context, {
				workspaceId: input.workspaceId,
				taskId: null,
				kind: "job",
				outcome: "failed",
				note: `job ${job.name} failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	};

	const tickWorkspace = async (snapshot: PipelineWorkspaceSnapshot, context: TickContext): Promise<void> => {
		const { workspaceId } = snapshot;
		const { config } = context.parsed;
		const settings = getWorkspacePipelineSettings(config, workspaceId);
		const full = !config.pipeline.paused && isPipelineWorkspace(settings);
		const paths = getPaths(workspaceId);
		const state = await loadState(workspaceId);
		const records: WatchdogDecisionRecord[] = [];
		const attentionText = await readText(paths.attention);
		const userItemIds = readUserItemIds(attentionText);
		const sessions = new Map(snapshot.sessions.map((session) => [session.taskId, session]));
		const cards = listCards(snapshot);
		const calibrationIds = await readCalibrationRunIds(paths.calibrationDir);
		const roles = new Map<string, WatchdogCardRole>(
			cards.map(({ card }) => [card.id, resolveWatchdogCardRole(card, calibrationIds)]),
		);
		const attention: string[] = [];
		const queued: string[] = [];
		const triageCooldownMs = config.watchdog.triageCooldownMin * MIN;
		const queueIssue = (key: string, taskId: string | null, issue: string): void => {
			const last = state.triaged[key];
			if (last && context.now - Date.parse(last) < triageCooldownMs) {
				return;
			}
			if (context.act) {
				state.triaged[key] = new Date(context.now).toISOString();
			}
			queued.push(`- ${taskId ? `${taskId}: ` : ""}${issue}`);
			record(records, context, { workspaceId, taskId, kind: "stall", outcome: outcomeOf(context), note: issue });
		};

		if (full) {
			const pipelineState = await deps.store.load(workspaceId);
			const { policy } = await resolvePolicy(context.parsed, workspaceId);
			const qaGated = (card: RuntimeBoardCard): boolean => {
				if (!isPipelineCandidate(card)) {
					return false;
				}
				const { effective } = toEffectiveCard({
					card,
					session: sessions.get(card.id) ?? null,
					workspaceId,
					selectedAgentId: snapshot.selectedAgentId,
					agentDefaultModels: context.agentDefaultModels,
				});
				const { history, round } = readCardHistory(pipelineState.cards[card.id]);
				return policy.qaPolicy({ dev: { ...effective, role: "dev" }, round, history }).kind === "qa";
			};
			const stalls = detectStalls({
				board: snapshot.board,
				sessions,
				roles,
				pipelineCards: pipelineState.cards,
				qaGated,
				userItemIds,
				resumed: state.resumed,
				pidPressure: context.pidLevel !== "none",
				pidBrownout: context.pidLevel === "brownout",
				settings: config.watchdog.stall,
				now: context.now,
			});
			for (const item of stalls.items) {
				queueIssue(item.key, item.taskId, item.issue);
			}
			for (const resume of stalls.continues) {
				if (!context.act) {
					record(records, context, {
						workspaceId,
						taskId: resume.taskId,
						kind: "continue",
						outcome: "report",
						note: `In Progress with a dead session for ${resume.minutes} min: would send one continue`,
					});
					continue;
				}
				state.resumed[resume.resumeKey] = new Date(context.now).toISOString();
				const result = await deps.actions
					.request({ kind: "deliverInput", workspaceId, taskId: resume.taskId, text: CONTINUE_TEXT })
					.catch((error: unknown) => ({ ok: false, status: "error", error: String(error) }) as const);
				record(records, context, {
					workspaceId,
					taskId: resume.taskId,
					kind: "continue",
					outcome: result.ok ? "acted" : "failed",
					note: `In Progress with its session dead for ${resume.minutes} min; sent continue: ${result.status}${result.error ? ` (${result.error})` : ""}`,
				});
			}
			const qaLog = await readText(paths.qaLog);
			const columns = new Map(cards.map(({ column, card }) => [card.id, column]));
			for (const [taskId, entry] of Object.entries(pipelineState.cards)) {
				const escalation = readEscalation(entry);
				const column = columns.get(taskId);
				if (!escalation || !column || column === "trash") {
					continue;
				}
				const verdict = readTriageVerdict(qaLog, taskId) ?? "no triage yet";
				if (verdict !== "fixed") {
					attention.push(
						`- **${taskId}** (${column}): escalated ${escalation.at} (${escalation.reason}); triage: ${verdict}`,
					);
				}
			}
		}

		const trust = new Map<string, boolean | null>();
		for (const { card } of cards) {
			const session = sessions.get(card.id);
			if (session?.workspacePath && session.agentId) {
				const key = `${session.agentId}\u0000${session.workspacePath}`;
				if (!trust.has(key)) {
					trust.set(key, await isTrusted(session.agentId, session.workspacePath));
				}
			}
		}
		for (const wait of findPromptWaits({
			cards,
			sessions,
			selectedAgentId: snapshot.selectedAgentId,
			now: context.now,
			stuckMs: config.watchdog.stall.promptMin * MIN,
			hooksOnPromptSubmit,
			trusted: (agentId, path) => trust.get(`${agentId}\u0000${path}`) ?? null,
			agentLabel: getAgentLabel,
		})) {
			if (!userItemIds.has(wait.taskId)) {
				attention.push(`- **${wait.taskId}** (prompt): ${wait.text}`);
				record(records, context, {
					workspaceId,
					taskId: wait.taskId,
					kind: "prompt",
					outcome: outcomeOf(context),
					note: wait.text,
				});
			}
		}

		if (full) {
			if (context.pidUsage && context.pidLevel !== "none") {
				attention.push(formatPidPressureItem(context.pidUsage, context.pidLevel, context.pressureSweep));
				if (context.pidLevel === "brownout") {
					for (const { column, card } of cards) {
						if (column !== "in_progress" || sessions.get(card.id)?.state !== "running" || state.paused[card.id]) {
							continue;
						}
						if (!context.act) {
							record(records, context, {
								workspaceId,
								taskId: card.id,
								kind: "pause",
								outcome: "report",
								note: "PID brownout: would pause the running agent (Esc)",
							});
							continue;
						}
						state.paused[card.id] = new Date(context.now).toISOString();
						const result = await deps.actions
							.request({ kind: "interrupt", workspaceId, taskId: card.id })
							.catch((error: unknown) => ({ ok: false, error: String(error) }));
						record(records, context, {
							workspaceId,
							taskId: card.id,
							kind: "pause",
							outcome: result.ok ? "acted" : "failed",
							note: `PID brownout: paused the running agent${result.error ? ` (${result.error})` : ""}`,
						});
					}
				}
			} else if (context.pidLevel === "none") {
				state.paused = {};
			}
			const idle = detectPipelineIdle({
				board: snapshot.board,
				roles,
				now: context.now,
				newCardGraceMin: config.watchdog.stall.newCardGraceMin,
			});
			if (idle) {
				attention.push(idle);
			}
			const planText = await readText(paths.orchestratorPlan);
			if (
				config.orchestrator.wake.enabled &&
				!isBoardBusy(snapshot.board) &&
				context.pidLevel === "none" &&
				planHasOpenSteps(planText)
			) {
				queued.push(
					`- board idle (nothing in progress or review) and ${paths.orchestratorPlan} has open steps: do the next one`,
				);
			}
		}

		queued.push(...(await takeDueWakeRequests(snapshot, paths, context, records)));

		for (const item of attention) {
			record(records, context, {
				workspaceId,
				taskId: null,
				kind: "attention",
				outcome: outcomeOf(context),
				note: item,
			});
		}
		if (context.act) {
			const next = renderAttention(attentionText, attention, new Date(context.now));
			if (next.changed) {
				if (next.text) {
					await mkdir(dirname(paths.attention), { recursive: true });
					await writeFile(paths.attention, next.text, "utf8");
				} else if (attentionText) {
					await unlink(paths.attention).catch(() => {});
				}
				deps.log(
					`watchdog ${workspaceId}: ${attention.length ? `ATTENTION: ${attention.length} item(s) → ${paths.attention}` : "ATTENTION cleared"}`,
				);
			}
		}

		const planHeldIds = readPlanHeldIds(await readText(paths.orchestratorPlan));
		const wakeItems = [
			...attention.filter(
				(item) =>
					!item.includes(PID_PRESSURE_ITEM_MARKER) &&
					!(context.pidLevel !== "none" && item.includes(PIPELINE_IDLE_ITEM_MARKER)) &&
					!isHandedOver(item, userItemIds, planHeldIds),
			),
			...queued,
		];
		if (wakeItems.length > 0 || state.wakeRetry.length > 0 || state.wakeEnter) {
			await wake(snapshot, paths, state, wakeItems, queued, context, records);
		}

		if (full) {
			const jobs: PipelineFeatureJob[] = [];
			if (config.watchdog.pruneDone.enabled) {
				jobs.push({
					name: "prune-done",
					everyMin: PRUNE_EVERY_MIN,
					run: async () => {
						const result = await deps.actions.request({
							kind: "pruneDone",
							workspaceId,
							days: config.watchdog.pruneDone.days,
						});
						if (!result.ok) {
							throw new Error(result.error ?? result.summary);
						}
						return result.summary;
					},
				});
			}
			jobs.push(...deps.features.listJobs(workspaceId));
			for (const job of jobs) {
				await runJob(job, { workspaceId, state, context, records });
			}
		}

		if (context.act) {
			await saveWatchdogState(paths.state, state, context.now);
		}
		if (records.length > 0) {
			await decisionLog.append(records);
		}
	};

	const takeDueWakeRequests = async (
		snapshot: PipelineWorkspaceSnapshot,
		paths: WatchdogWorkspacePaths,
		context: TickContext,
		records: WatchdogDecisionRecord[],
	): Promise<string[]> => {
		const pending = await readWakeRequests(paths.wakeRequests);
		if (pending.length === 0) {
			return [];
		}
		const check = await checkWakeRequests({
			requests: pending,
			board: snapshot.board,
			now: context.now,
			probe: probeModel,
		});
		for (const line of check.log) {
			record(records, context, {
				workspaceId: snapshot.workspaceId,
				taskId: null,
				kind: "wake-request",
				outcome: outcomeOf(context),
				note: line,
			});
		}
		const unchanged =
			check.items.length === 0 &&
			check.remaining.length === pending.length &&
			check.remaining.every((request, index) => JSON.stringify(request) === JSON.stringify(pending[index]));
		if (!context.act || unchanged) {
			return [];
		}
		// Requests added while this check ran are kept; checked ones are replaced by their updated copy or removed.
		const checkedIds = new Set(pending.map((request) => request.id));
		await updateWakeRequests(paths.wakeRequests, (requests) => ({
			requests: [...check.remaining, ...requests.filter((request) => !checkedIds.has(request.id))],
			value: null,
		}));
		return check.items;
	};

	const wake = async (
		snapshot: PipelineWorkspaceSnapshot,
		paths: WatchdogWorkspacePaths,
		state: WatchdogWorkspaceState,
		items: readonly string[],
		queued: readonly string[],
		context: TickContext,
		records: WatchdogDecisionRecord[],
	): Promise<void> => {
		const { workspaceId } = snapshot;
		const wakeSettings = context.parsed.config.orchestrator.wake;
		if (!wakeSettings.enabled) {
			record(records, context, {
				workspaceId,
				taskId: null,
				kind: "wake",
				outcome: "skipped",
				note: `orchestrator.wake.enabled is off; not waking for ${items.length} item(s)${context.parsed.config.watchdog.triageCards ? " (TRIAGE cards are not built: watchdog.triageCards has no effect)" : ""}`,
			});
			return;
		}
		const targetWorkspaceId = wakeSettings.target ?? workspaceId;
		const targetSnapshot = snapshots.get(targetWorkspaceId);
		if (!targetSnapshot) {
			record(records, context, {
				workspaceId,
				taskId: null,
				kind: "error",
				outcome: "failed",
				note: `orchestrator.wake.target ${targetWorkspaceId} is not a registered workspace; nothing woken`,
			});
			return;
		}
		// The orchestrator is the agent selected in Kanban settings (never a hard-coded id).
		const agentId = targetSnapshot.selectedAgentId;
		const sessionId = createHomeAgentSessionId(targetWorkspaceId, agentId);
		const startedAt = justStarted.get(sessionId);
		const reportedSession = targetSnapshot.sessions.find((session) => session.taskId === sessionId) ?? null;
		const session: PipelineSessionView | null =
			isOrchestratorSessionLive(reportedSession) ||
			startedAt === undefined ||
			context.now - startedAt > JUST_STARTED_MS
				? reportedSession
				: { taskId: sessionId, agentId, modelId: null, state: "running", pid: -1 };
		const headlessKey = `headless:${targetWorkspaceId}`;
		const headlessStartedAt = justStarted.get(headlessKey);
		// A run that was just spawned may not have written its lock yet.
		const runningHeadlessPid =
			(await headlessPid(targetWorkspaceId)) ||
			(headlessStartedAt !== undefined && context.now - headlessStartedAt <= JUST_STARTED_MS ? -1 : 0);
		const target = {
			workspaceId: targetWorkspaceId,
			projectPath: targetSnapshot.workspacePath,
			agentId,
			sessionId,
			session,
		};
		const text = (fresh: readonly string[]) =>
			buildWakeText({
				workspaceId,
				projectPath: snapshot.workspacePath,
				attentionPath: paths.attention,
				decisionsPath: getPipelineDecisionLogPath(workspaceId),
				qaLogPath: paths.qaLog,
				items: fresh,
				now: new Date(context.now),
			});
		const targetPaths = getPaths(targetWorkspaceId);
		const queueForHeadless = async (fresh: readonly string[]) =>
			await appendOrchestratorQueue(targetPaths.orchestratorQueue, workspaceId, fresh, new Date(context.now));

		if (!context.act) {
			const live = isOrchestratorSessionLive(session);
			const route = live
				? `type into ${sessionId}`
				: wakeSettings.mode === "headless" && hasHeadlessRunner(agentId)
					? `start a headless ${agentId} run in ${targetWorkspaceId}`
					: `start ${sessionId} with the wake as its first input`;
			record(records, context, {
				workspaceId,
				taskId: null,
				kind: "wake",
				outcome: "report",
				note: `would wake the orchestrator (${route}): ${items.map((item) => item.replace(/^- /u, "")).join(" | ")}`.slice(
					0,
					600,
				),
			});
			return;
		}

		let outcome: WakeOutcome;
		try {
			outcome = await wakeOrchestrator({
				state,
				items,
				queued,
				target,
				mode: wakeSettings.mode,
				text,
				now: context.now,
				cooldownMs: wakeSettings.cooldownMin * MIN,
				retryMs: context.parsed.config.watchdog.triageCooldownMin * MIN,
				deps: {
					headlessPid: () => runningHeadlessPid,
					hasHeadlessRunner: hasHeadlessRunner(agentId),
					queueForHeadless,
					startHeadless: async (fresh) => {
						await queueForHeadless(fresh);
						const started = startHeadlessRun({
							workspaceId: targetWorkspaceId,
							projectPath: targetSnapshot.workspacePath,
							agentId,
							timeoutMin: wakeSettings.timeoutMin,
							liveSessionMin: wakeSettings.liveSessionMin,
						});
						if (started.ok) {
							justStarted.set(headlessKey, context.now);
						}
						return started;
					},
					deliver: async (input) =>
						await deps.actions
							.request({ kind: "deliverInput", workspaceId: targetWorkspaceId, taskId: sessionId, text: input })
							.catch(
								(error: unknown) =>
									({
										ok: false,
										status: "error",
										evidence: null,
										enterAttempts: 0,
										summary: null,
										error: String(error),
									}) as const,
							),
					startSession: async (prompt) => {
						const result = await deps.actions
							.request({ kind: "startOrchestratorSession", workspaceId: targetWorkspaceId, agentId, prompt })
							.catch((error: unknown) => ({ ok: false, taskId: sessionId, error: String(error) }));
						if (result.ok) {
							justStarted.set(sessionId, context.now);
						}
						return result;
					},
				},
			});
		} catch (error) {
			record(records, context, {
				workspaceId,
				taskId: null,
				kind: "wake",
				outcome: "failed",
				note: `wake failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}
		if (outcome.path === "none") {
			return;
		}
		record(records, context, {
			workspaceId,
			taskId: null,
			kind: "wake",
			outcome: outcome.ok ? "acted" : "failed",
			note: `${outcome.path}: ${outcome.detail}: ${outcome.items.map((item) => item.replace(/^- /u, "")).join(" | ")}`.slice(
				0,
				600,
			),
		});
		deps.log(
			`watchdog ${workspaceId}: wake orchestrator (${agentId} in ${targetWorkspaceId}): ${outcome.path}: ${outcome.detail}`,
		);
	};

	return {
		observe: (snapshot) => {
			snapshots.set(snapshot.workspaceId, snapshot);
		},
		forget: (workspaceId) => {
			snapshots.delete(workspaceId);
			states.delete(workspaceId);
		},
		tick: async () => {
			const parsed = await deps.readConfig();
			const mode = parsed.config.watchdog.mode;
			if (mode === "off" || snapshots.size === 0) {
				return;
			}
			const act = mode === "on";
			const at = now();
			const pidUsage = await readPidUsage();
			const pidLevel = getPidPressureLevel(pidUsage, parsed.config.watchdog.pids);
			if (pidLevel === "none") {
				lastPressureSweep = null;
			} else if (act && at - lastPressureSweepAt >= PRESSURE_SWEEP_EVERY_MS) {
				lastPressureSweepAt = at;
				const swept = await deps.actions.request({ kind: "sweepProcesses" }).catch(() => null);
				lastPressureSweep = swept?.ok ? { zombies: swept.zombies, terminated: swept.terminated } : null;
				deps.log(
					`watchdog: PID pressure ${pidUsage?.current}/${pidUsage?.max}: process sweep ${swept?.ok ? `found ${swept.zombies} zombie(s), terminated ${swept.terminated} orphan(s)` : `failed${swept?.error ? ` (${swept.error})` : ""}`}`,
				);
			}
			const context: TickContext = {
				parsed,
				mode,
				act,
				now: at,
				pidUsage,
				pidLevel,
				pressureSweep: lastPressureSweep,
				agentDefaultModels: deps.loadAgentDefaultModels ? await deps.loadAgentDefaultModels(parsed) : {},
			};
			await updatePidFlags(context).catch((error: unknown) =>
				deps.log(`watchdog: could not update the PID pressure flags: ${String(error)}`),
			);
			for (const snapshot of [...snapshots.values()]) {
				try {
					await tickWorkspace(snapshot, context);
				} catch (error) {
					deps.log(
						`watchdog ${snapshot.workspaceId}: tick failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		},
	};
}
