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
//     orchestrator plan's open steps, the post-restart check (restart-checks.ts: a Review card whose dead QA card the
//     gate did not replace, a card still held for a restart), prune-done and the feature jobs. A Cline card's silent stall (running, but its
//     session file shows no progress; cline-turn-check.ts) is only reported: recovery owns its nudge, so where
//     recovery acts the watchdog just logs it, and elsewhere it becomes an item. A workspace on the `default` kit with landing
//     `off` gets nothing else, as the legacy kit watched only its configured projects.
//   - machine-wide, once per tick: PID pressure (the flag files, the process sweep). Its notices go to the server
//     log; a workspace's ATTENTION.md says that its own new work is held, and that line never wakes anyone.
//
// Isolated by project (docs/fork/watchdog-isolation.md): one worker, but each workspace has its own state file,
// ATTENTION.md, wake requests and headless queue, and its items wake only its own orchestrator. There is no
// cross-workspace wake target any more.
//
// Ported from archive/devteam-kit:services/review-watch.mjs@6da71597 (tick, finishTick, triage, pruneDone) and kit
// main 00514f2 (following Kanban's selected agent; its wakeTarget, one orchestrator for every workspace, is dropped).
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
	getWorkspacePipelineSettings,
	type ParsedPipelineConfig,
	resolveWorkspaceWakeSettings,
	type WatchdogMode,
} from "../../config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardCard, RuntimeBoardColumnId } from "../../core/api-contract";
import type { EffectiveModelConfig } from "../../core/effective-agent";
import { createHomeAgentSessionId } from "../../core/home-agent-session";
import { resolveIsolationMode } from "../../isolation/isolation-settings";
import { KANBAN_SESSION_CREDENTIAL_ENV, KANBAN_SESSION_WORKSPACE_ENV } from "../../isolation/session-identity";
import { createRoutingPolicy, type RoutingPolicy } from "../../kits/policy";
import { type KitCatalog, resolveWorkspaceKit } from "../../kits/resolve-kit";
import { type AgentToolProcessFinder, createAgentToolProcessFinder } from "../../server/process-reaper";
import {
	getClineDataDirPath,
	getOrchestratorLockPath,
	getPidPressureFlagPaths,
	getPipelineDecisionLogPath,
	getWatchdogWorkspacePaths,
	type WatchdogWorkspacePaths,
} from "../../state/kanban-home";
import { getAgentTurnEndSource } from "../../terminal/agent-session-adapters";
import { createClineSessionFileReader } from "../../terminal/cline-session-files";
import {
	type ClineSilentStall,
	describeClineSilentStall,
	getSessionProgressAt,
	isClineShellTool,
	readClineSilentStall,
} from "../../terminal/cline-turn-check";
import {
	agentHooksOnPromptSubmit,
	getAgentLabel,
	hasHeadlessOrchestratorRunner,
	isAgentWorkspaceTrusted,
} from "../../terminal/orchestrator-agents";
import { createWorkspaceJsonLinesLog, type WorkspaceJsonLinesLog } from "../decision-log";
import {
	getRecoveryScope,
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
import { detectRestartQaGaps } from "./restart-checks";
import {
	CONTINUE_TEXT,
	detectPipelineIdle,
	detectStalls,
	isBoardBusy,
	readEscalation,
	readStop,
	resolveWatchdogCardRole,
	type WatchdogCardRole,
} from "./stalls";
import { buildWakeText, isOrchestratorSessionLive, type WakeOutcome, wakeKey, wakeOrchestrator } from "./wake";
import { checkWakeRequests, describeWakeRequestCondition, readWakeRequests, updateWakeRequests } from "./wake-requests";
import { loadWatchdogState, saveWatchdogState, type WatchdogWorkspaceState } from "./watchdog-state";
import { readCalibrationRunIds, readUndecidedRunoffCardIds } from "./workspace-data";

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
		env?: Record<string, string>;
	}) => { ok: boolean; pid?: number; error?: string };
	probeModel?: (provider: string, model: string) => Promise<boolean>;
	/**
	 * Core jobs of every workspace (not only pipeline ones), such as the issue import's sync (src/issues/issue-job.ts);
	 * they run through the same job runner as prune-done and the kit features' jobs.
	 */
	coreJobs?: (input: {
		workspaceId: string;
		getSnapshot: () => PipelineWorkspaceSnapshot;
		config: ParsedPipelineConfig["config"];
	}) => PipelineFeatureJob[];
	/** Items that only ride along when the orchestrator is woken anyway (the issue import's started-card updates). */
	takeWakeNotes?: (workspaceId: string) => Promise<string[]>;
	isTrusted?: (agentId: RuntimeAgentId, directory: string) => Promise<boolean | null>;
	hooksOnPromptSubmit?: (agentId: RuntimeAgentId) => boolean;
	hasHeadlessRunner?: (agentId: RuntimeAgentId) => boolean;
	/** A card worktree's silent Cline stall (readClineSilentStall, the reader recovery decides on too). */
	readSilentStall?: (input: {
		worktreePath: string;
		kanbanProgressAt: number | null;
		dataDir: string;
		now: number;
	}) => Promise<ClineSilentStall | null>;
	/** A process the agent started that still runs in the worktree (recovery asks the same, findAgentToolProcess). */
	findRunningTool?: AgentToolProcessFinder;
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

/** Why recovery doesn't act on a workspace (getRecoveryScope), for an item that nothing else will act on. */
function describeRecoveryNotActing(
	config: ParsedPipelineConfig["config"],
	settings: ReturnType<typeof getWorkspacePipelineSettings>,
): string {
	const { mode } = config.pipeline.recovery;
	if (mode === "off") {
		return "pipeline.recovery.mode is off";
	}
	if (!settings.recovery.enabled) {
		return "recovery is disabled for this workspace (workspaces.<id>.recovery.enabled)";
	}
	if (mode === "report") {
		return "pipeline.recovery.mode is report";
	}
	return "the workspace is a shadow workspace (pipeline.shadow)";
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
	const clineReader = deps.readSilentStall ? null : createClineSessionFileReader();
	const findRunningTool = deps.findRunningTool ?? createAgentToolProcessFinder();
	const readSilentStall =
		deps.readSilentStall ??
		(async (input: { worktreePath: string; kanbanProgressAt: number | null; dataDir: string; now: number }) =>
			clineReader
				? await readClineSilentStall({
						reader: clineReader,
						settings: { dataDir: input.dataDir },
						workspacePath: input.worktreePath,
						kanbanProgressAt: input.kanbanProgressAt,
						now: input.now,
					})
				: null);

	const snapshots = new Map<string, PipelineWorkspaceSnapshot>();
	const states = new Map<string, WatchdogWorkspaceState>();
	// decision key → when it was last logged.
	const loggedDecisions = new Map<string, number>();
	// Orchestrator sessions / headless runs started this worker life: target key → when.
	const justStarted = new Map<string, number>();
	// workspaceId → when the post-restart check first saw a QA card gone (restart-checks.ts firstSeenGone).
	const restartFirstSeenGone = new Map<string, Map<string, number>>();
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
		if (!pidFlagsSet) {
			deps.log(
				`watchdog: PID pressure, level ${context.pidLevel}${usage ? ` (${usage.current}/${usage.max})` : ""}`,
			);
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
		// Wakes off for this workspace: nothing reaches an orchestrator (never another workspace's instead), so what
		// would have woken it is listed in its own ATTENTION.md, every tick while it holds.
		const wakesOn = resolveWorkspaceWakeSettings(config, workspaceId).enabled;
		const queueIssue = (key: string, taskId: string | null, issue: string): void => {
			if (!wakesOn) {
				attention.push(`- ${taskId ? `**${taskId}** (stall): ` : ""}${issue}`);
				record(records, context, { workspaceId, taskId, kind: "stall", outcome: outcomeOf(context), note: issue });
				return;
			}
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
				openRunoffCardIds: await readUndecidedRunoffCardIds(paths.runoffs),
				resumed: state.resumed,
				pidPressure: context.pidLevel !== "none",
				pidBrownout: context.pidLevel === "brownout",
				settings: config.watchdog.stall,
				now: context.now,
			});
			// What a restart left behind and its automatic fix didn't handle (a dead QA card the gate didn't replace, an
			// orphan nobody resumed) shows up a grace after the start and replaces the generic review stall for that card.
			let firstSeenGone = restartFirstSeenGone.get(workspaceId);
			if (!firstSeenGone) {
				firstSeenGone = new Map();
				restartFirstSeenGone.set(workspaceId, firstSeenGone);
			}
			const restart = detectRestartQaGaps({
				board: snapshot.board,
				sessions,
				roles,
				pipelineCards: pipelineState.cards,
				serverStartedAt: snapshot.serverStartedAt,
				userItemIds,
				pidPressure: context.pidLevel !== "none",
				firstSeenGone,
				settings: {
					graceMin: config.watchdog.stall.restartGraceMin,
					resumeGapSec: config.pipeline.recovery.resumeGapSec,
				},
				now: context.now,
			});
			for (const { taskId, note } of restart.notes) {
				record(records, context, { workspaceId, taskId, kind: "stall", outcome: "skipped", note });
			}
			const restartFlagged = new Set(restart.items.map((item) => item.taskId));
			for (const item of [
				...restart.items,
				...stalls.items.filter((item) => !restartFlagged.has(item.taskId) || !item.key.endsWith(":review-stall")),
			]) {
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
			const recoveryActs = getRecoveryScope(config, settings).act;
			const stallNudgeMs = config.pipeline.recovery.stallNudgeMin * MIN;
			const clineDataDir = getClineDataDirPath(config.agents.cline.dataDir);
			for (const { column, card } of cards) {
				const session = sessions.get(card.id);
				if (
					column !== "in_progress" ||
					roles.get(card.id)?.role !== "dev" ||
					!session?.live ||
					session.state !== "running" ||
					!session.workspacePath
				) {
					continue;
				}
				const { effective } = toEffectiveCard({
					card,
					session,
					workspaceId,
					selectedAgentId: snapshot.selectedAgentId,
					agentDefaultModels: context.agentDefaultModels,
				});
				if (getAgentTurnEndSource(effective.agentId) !== "cline-session-files") {
					continue;
				}
				const stall = await readSilentStall({
					worktreePath: session.workspacePath,
					kanbanProgressAt: getSessionProgressAt(session),
					dataDir: clineDataDir,
					now: context.now,
				});
				if (!stall || stall.idleMs < stallNudgeMs) {
					continue;
				}
				// A long test run or build: its shell tool writes nothing to the session until it returns.
				if (
					stall.kind === "interrupted_tool" &&
					stall.tools.some(isClineShellTool) &&
					(await findRunningTool(session.workspacePath, session.pid ?? null))
				) {
					continue;
				}
				const issue = `dev card is running but its Cline session is silent: ${describeClineSilentStall(stall)}`;
				if (recoveryActs) {
					// One owner: recovery nudges (and escalates) it; a second "continue" from here would double it.
					record(records, context, {
						workspaceId,
						taskId: card.id,
						kind: "stall",
						outcome: "skipped",
						note: `${issue}; recovery owns it`,
					});
				} else {
					queueIssue(
						`${card.id}:silent-stall`,
						card.id,
						`${issue}; nothing nudges it (${describeRecoveryNotActing(config, settings)})`,
					);
				}
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
			// The kit answered `stop` after a FAIL: the card waits in Review for a human (plan §4.0, onFail default).
			for (const [taskId, entry] of Object.entries(pipelineState.cards)) {
				const stop = readStop(entry);
				if (stop && !readEscalation(entry) && columns.get(taskId) === "review") {
					attention.push(
						`- **${taskId}** (review): stopped ${stop.at} (${stop.reason}); the kit does not rework it`,
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
				resolveWorkspaceWakeSettings(config, workspaceId).enabled &&
				!isBoardBusy(snapshot.board) &&
				context.pidLevel === "none" &&
				planHasOpenSteps(planText)
			) {
				queued.push(
					`- board idle (nothing in progress or review) and ${paths.orchestratorPlan} has open steps: do the next one`,
				);
			}
		}

		if (wakesOn) {
			queued.push(...(await takeDueWakeRequests(snapshot, paths, context, records)));
		} else {
			// Left in the request file: they wake the orchestrator once wakes are on again.
			for (const request of await readWakeRequests(paths.wakeRequests)) {
				attention.push(`- **wake request** (${describeWakeRequestCondition(request)}): ${request.issue}`);
			}
		}

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
		// Notes ride along with a wake of this workspace's own orchestrator; with its wakes off they stay in its issue state.
		if (context.act && wakesOn && wakeItems.length > 0 && deps.takeWakeNotes) {
			const notes = await deps.takeWakeNotes(workspaceId).catch(() => []);
			queued.push(...notes);
			wakeItems.push(...notes);
		}
		if (wakeItems.length > 0 || state.wakeRetry.length > 0 || state.wakeEnter) {
			await wake(snapshot, paths, state, wakeItems, queued, context, records);
		}

		const jobs: PipelineFeatureJob[] = [];
		if (full) {
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
		}
		jobs.push(
			...(deps.coreJobs?.({
				workspaceId,
				getSnapshot: () => snapshots.get(workspaceId) ?? snapshot,
				config,
			}) ?? []),
		);
		for (const job of jobs) {
			await runJob(job, { workspaceId, state, context, records });
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
		// Project isolation: a workspace's items wake only its own orchestrator (its sidebar session or a headless run
		// in its project), never another workspace's (docs/fork/watchdog-isolation.md). Every request below names
		// `workspaceId` as both the target and `fromWorkspaceId`, and the server refuses any pair that differs.
		const { workspaceId } = snapshot;
		const wakeSettings = resolveWorkspaceWakeSettings(context.parsed.config, workspaceId);
		if (!wakeSettings.enabled) {
			const override = getWorkspacePipelineSettings(context.parsed.config, workspaceId).orchestrator.wake.enabled;
			record(records, context, {
				workspaceId,
				taskId: null,
				kind: "wake",
				outcome: "skipped",
				note: `${override === false ? `workspaces.${workspaceId}.orchestrator.wake.enabled` : "orchestrator.wake.enabled"} is off; ${items.length} item(s) stay in ${paths.attention} only${context.parsed.config.watchdog.triageCards ? " (TRIAGE cards are not built: watchdog.triageCards has no effect)" : ""}`,
			});
			return;
		}
		// The orchestrator is the agent selected in Kanban settings (never a hard-coded id).
		const agentId = snapshot.selectedAgentId;
		const sessionId = createHomeAgentSessionId(workspaceId, agentId);
		const startedAt = justStarted.get(sessionId);
		const reportedSession = snapshot.sessions.find((session) => session.taskId === sessionId) ?? null;
		const session: PipelineSessionView | null =
			isOrchestratorSessionLive(reportedSession) ||
			startedAt === undefined ||
			context.now - startedAt > JUST_STARTED_MS
				? reportedSession
				: { taskId: sessionId, agentId, modelId: null, state: "running", pid: -1 };
		const headlessKey = `headless:${workspaceId}`;
		const headlessStartedAt = justStarted.get(headlessKey);
		// A run that was just spawned may not have written its lock yet.
		const runningHeadlessPid =
			(await headlessPid(workspaceId)) ||
			(headlessStartedAt !== undefined && context.now - headlessStartedAt <= JUST_STARTED_MS ? -1 : 0);
		// A headless run carries no session credential and no isolation guardrails: under `enforce` the wake goes
		// to the sidebar session, which startTaskSession launches with both.
		const wakeMode =
			resolveIsolationMode(context.parsed.config, workspaceId) === "enforce" ? "sidebar" : wakeSettings.mode;
		const target = {
			workspaceId,
			projectPath: snapshot.workspacePath,
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
		const queueForHeadless = async (fresh: readonly string[]) =>
			await appendOrchestratorQueue(paths.orchestratorQueue, workspaceId, fresh, new Date(context.now));

		if (!context.act) {
			const live = isOrchestratorSessionLive(session);
			const route = live
				? `type into ${sessionId}`
				: wakeMode === "headless" && hasHeadlessRunner(agentId)
					? `start a headless ${agentId} run in ${workspaceId}`
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
				mode: wakeMode,
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
						// The run is the workspace's orchestrator: its `kanban` calls carry the workspace's session
						// credential, bound to the run's pid (project isolation; an old server without the kind answers
						// with an error, and the run starts without one, as before).
						const issued = await deps.actions
							.request({ kind: "issueOrchestratorCredential", workspaceId, agentId })
							.catch(() => null);
						const credential = issued?.ok ? issued.credential : null;
						const started = startHeadlessRun({
							workspaceId,
							projectPath: snapshot.workspacePath,
							agentId,
							timeoutMin: wakeSettings.timeoutMin,
							liveSessionMin: wakeSettings.liveSessionMin,
							...(credential
								? {
										env: {
											[KANBAN_SESSION_CREDENTIAL_ENV]: credential,
											[KANBAN_SESSION_WORKSPACE_ENV]: workspaceId,
										},
									}
								: {}),
						});
						if (started.ok) {
							justStarted.set(headlessKey, context.now);
							if (credential && started.pid) {
								await deps.actions
									.request({ kind: "bindOrchestratorCredential", credential, pid: started.pid })
									.catch(() => null);
							}
						}
						return started;
					},
					deliver: async (input) =>
						await deps.actions
							.request({
								kind: "deliverInput",
								workspaceId,
								taskId: sessionId,
								text: input,
								fromWorkspaceId: workspaceId,
							})
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
							.request({
								kind: "startOrchestratorSession",
								workspaceId,
								agentId,
								prompt,
								fromWorkspaceId: workspaceId,
							})
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
		deps.log(`watchdog ${workspaceId}: wake its orchestrator (${agentId}): ${outcome.path}: ${outcome.detail}`);
	};

	return {
		observe: (snapshot) => {
			snapshots.set(snapshot.workspaceId, snapshot);
		},
		forget: (workspaceId) => {
			snapshots.delete(workspaceId);
			states.delete(workspaceId);
			restartFirstSeenGone.delete(workspaceId);
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
