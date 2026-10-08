// The recovery stage of the pipeline worker: for each card In Progress or in Review, read why its agent stopped and
// decide (recovery.ts), and after a Kanban restart find the cards whose sessions died with the old server and resume
// them (restart-recovery.ts). It runs on every workspace snapshot the worker gets.
//
// Ships report-only (`pipeline.recovery.mode: "report"`): decisions go to the decision log and nothing is typed,
// resumed or written to pipeline-state.json, because the legacy kit's autoland still does all of this on the live
// pod and two owners would nudge and resume the same cards twice (plan §8.3). With `"on"` it acts on workspaces that
// have `workspaces.<id>.recovery.enabled` and no `pipeline.shadow`; actions go through the server (worker requests,
// RecoveryAction below), which owns the PTYs and the board.
//
// A nudge is confirmed only by a session state change or a hook. P1-5's deliverTaskInput also reports "delivered" on
// new PTY output after Enter, and a busy TUI echoes output without accepting the text, so an output-only delivery is
// logged as unconfirmed and the card is left alone for `nudgeCheckSec` before it is decided on again.
import type { PipelineConfig, WorkspacePipelineSettings } from "../config/pipeline-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeTaskInputDeliveryEvidence,
} from "../core/api-contract";
import type { EffectiveModel, EffectiveModelConfig } from "../core/effective-agent";
import type { RoutingPolicy } from "../kits/policy";
import { getAgentRecoveryProfile, getAgentTurnEndSource } from "../terminal/agent-session-adapters";
import type { ClineSessionDetail } from "../terminal/cline-session-files";
import { isClineShellToolPending } from "../terminal/cline-turn-check";
import { evaluateClineTurnEnd } from "../terminal/cline-turn-outcome";
import type { PipelineDecisionRecord } from "./decision-log";
import { getRecoveryScope, type PipelineSessionView, type PipelineWorkspaceSnapshot, toEffectiveCard } from "./engine";
import type { PipelineWorkspaceState } from "./pipeline-state";
import { type CapacityCard, findProviderCapacityHold } from "./provider-capacity";
import { readQaGateEntry } from "./qa-gate";
import {
	applyOutageProbe,
	decideRecovery,
	describeCapacityHold,
	isOrphanMarkStale,
	leftReviewPatch,
	type RecoveryDecision,
	type RecoveryFlowPatch,
	readRecoveryFlow,
} from "./recovery";
import { buildPoisonedHistoryPrompt, buildRestartResumeLaunch, CLEAR_SETTLE_MS } from "./recovery-prompts";
import { planRestartRecovery, type RestartManifest, type RestartOrphan } from "./restart-recovery";

/**
 * What recovery asks the server to do for a card. The worker sends each one as an existing request
 * (worker-protocol.ts): `deliver` → the watchdog's `deliverInput`, `input` → `interrupt` (Esc), `resume` → the
 * card action `resumeTask`.
 */
export type RecoveryAction =
	/** Type text into the card's TUI with delivery confirmation (deliverTaskInput). */
	| { kind: "deliver"; taskId: string; text: string }
	/** Cancel the agent's request in flight (Esc). */
	| { kind: "input"; taskId: string; data: string }
	/**
	 * Start a new session for a card whose session died (restart recovery), then move it to In Progress.
	 * `continueConversation`: the agent continues its last conversation and `prompt` is the resume note
	 * (buildRestartResumeLaunch).
	 */
	| { kind: "resume"; taskId: string; prompt: string; agentId: RuntimeAgentId; continueConversation?: boolean };

export interface RecoveryActionResult {
	ok: boolean;
	/** deliverTaskInput's status for `deliver` (`delivered`, `undelivered`, `no_session`, …). */
	status?: string;
	/** What showed the agent picked up delivered input; `output` alone doesn't prove a busy TUI accepted it. */
	evidence?: RuntimeTaskInputDeliveryEvidence | null;
	error?: string;
}

/** How long a capacity-held resume waits before it looks again. */
const CAPACITY_RECHECK_MS = 30_000;
/** How long a resume held for PID pressure waits before it looks again (the legacy kit's 30 s). */
const PRESSURE_RECHECK_MS = 30_000;
/** How many capacity re-checks a resume makes before it gives up for this restart (about 30 min). */
const CAPACITY_MAX_CHECKS = 60;

export interface RecoveryStageDependencies {
	/** The card's worktree path, or null when it has none. */
	locateWorktree: (workspacePath: string, card: RuntimeBoardCard) => Promise<string | null>;
	/** The newest Cline CLI session of a worktree. */
	readSessionDetail: (worktreePath: string) => Promise<ClineSessionDetail | null>;
	/**
	 * A process the agent (`agentPid`, or a Cline hub daemon) started that still runs in the worktree, described for
	 * the log, or null (findAgentToolProcess in process-reaper.ts). Asked only while a shell tool call is pending.
	 */
	findRunningTool: (worktreePath: string, agentPid: number | null) => Promise<string | null>;
	canProbe: (provider: string | null) => boolean;
	probe: (target: EffectiveModel) => Promise<{ up: boolean; detail: string }>;
	act: (workspaceId: string, action: RecoveryAction) => Promise<RecoveryActionResult>;
	/** Deletes gitignored generated report dirs from a worktree; returns the dirs removed. */
	cleanGeneratedReports: (worktreePath: string) => Promise<string[]>;
	tagRestartWip: (worktreePath: string, taskId: string) => Promise<string | null>;
	hasTrackedChanges: (worktreePath: string) => Promise<boolean>;
	readManifest: (workspaceId: string) => Promise<RestartManifest | null>;
	/** Deletes the manifest recovery planned with, unless the file has been replaced since (removeRestartManifest). */
	removeManifest: (workspaceId: string, planned: RestartManifest) => Promise<void>;
	/** Records on the manifest that this start's recovery has planned with it (markRestartManifestPlanned). */
	markManifestPlanned: (workspaceId: string, planned: RestartManifest) => Promise<void>;
	consumeRecoverRequest: (workspaceId: string) => Promise<boolean>;
	/** Merges each patch into the card's `qaflow` entry of pipeline-state.json. */
	updateCards: (workspaceId: string, patches: ReadonlyMap<string, RecoveryFlowPatch>) => Promise<void>;
	/** For records made outside an evaluation (probe results, restart resumes). */
	appendRecords: (records: PipelineDecisionRecord[]) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	log: (message: string) => void;
}

export interface RecoveryEvaluationInput {
	snapshot: PipelineWorkspaceSnapshot;
	settings: WorkspacePipelineSettings;
	config: PipelineConfig;
	kitName: string;
	state: PipelineWorkspaceState;
	agentDefaultModels?: EffectiveModelConfig["agentDefaultModels"];
	/**
	 * The kit, given only where the rework loop runs (landing `qa`, not shadow) and so can carry out a takeover:
	 * an outage hold then asks its `onOutage`.
	 */
	takeoverPolicy?: RoutingPolicy | null;
}

export interface RecoveryStage {
	/** Decides for every card of the snapshot (and acts in mode "on"); returns the records to log. */
	evaluate: (input: RecoveryEvaluationInput) => Promise<PipelineDecisionRecord[]>;
	forget: (workspaceId: string) => void;
	/** Resolves once background work (probes, restart resumes) has settled. */
	idle: () => Promise<void>;
	close: () => void;
}

interface CardContext {
	card: RuntimeBoardCard;
	column: RuntimeBoardColumnId;
	session: PipelineSessionView | null;
	effective: ReturnType<typeof toEffectiveCard>;
}

function describeDecision(decision: RecoveryDecision): unknown {
	switch (decision.kind) {
		case "nudge":
			return { kind: decision.kind, cause: decision.cause, clear: decision.clear };
		case "cancel_hung":
			return { kind: decision.kind, followUp: decision.followUp.kind };
		case "probe":
			return { kind: decision.kind, target: decision.target };
		case "takeover":
			return { kind: decision.kind, to: decision.to };
		default:
			return { kind: decision.kind };
	}
}

function isConfirmed(result: RecoveryActionResult): boolean {
	return result.ok && (result.evidence === "state" || result.evidence === "hook");
}

export function createRecoveryStage(deps: RecoveryStageDependencies): RecoveryStage {
	const probing = new Set<string>();
	const background = new Set<Promise<void>>();
	/** workspaceId → the server start whose orphans were already planned. */
	const handledStarts = new Map<string, number>();
	const recovering = new Set<string>();
	const latest = new Map<string, RecoveryEvaluationInput>();
	let closed = false;

	const track = (work: Promise<void>): void => {
		const settled = work.catch((error: unknown) => {
			deps.log(`pipeline recovery: ${error instanceof Error ? error.message : String(error)}`);
		});
		background.add(settled);
		void settled.finally(() => background.delete(settled));
	};

	const baseRecord = (
		input: RecoveryEvaluationInput,
		context: CardContext | null,
		stage: PipelineDecisionRecord["stage"],
	): Omit<PipelineDecisionRecord, "answer" | "outcome" | "note"> => ({
		at: new Date(deps.now()).toISOString(),
		workspaceId: input.snapshot.workspaceId,
		taskId: context?.card.id ?? null,
		stage,
		kit: input.kitName,
		landingMode: input.settings.landing.mode,
		shadow: input.settings.pipeline.shadow,
		effectiveAgent: context ? context.effective.agentSource : null,
		model: context?.effective.effective.model ?? null,
		role: context?.effective.effective.role ?? null,
	});

	const contextsOf = (input: RecoveryEvaluationInput): CardContext[] => {
		const sessions = new Map(input.snapshot.sessions.map((session) => [session.taskId, session]));
		return input.snapshot.board.columns.flatMap((column) =>
			column.cards.map((card) => {
				const session = sessions.get(card.id) ?? null;
				return {
					card,
					column: column.id,
					session,
					effective: toEffectiveCard({
						card,
						session,
						workspaceId: input.snapshot.workspaceId,
						selectedAgentId: input.snapshot.selectedAgentId,
						agentDefaultModels: input.agentDefaultModels,
					}),
				};
			}),
		);
	};

	const readDetail = async (
		input: RecoveryEvaluationInput,
		context: CardContext,
	): Promise<ClineSessionDetail | null> => {
		if (getAgentTurnEndSource(context.effective.effective.agentId) !== "cline-session-files" || !context.session) {
			return null;
		}
		const worktree =
			context.session.workspacePath ?? (await deps.locateWorktree(input.snapshot.workspacePath, context.card));
		return worktree ? await deps.readSessionDetail(worktree) : null;
	};

	const startProbe = (input: RecoveryEvaluationInput, context: CardContext, target: EffectiveModel): void => {
		const key = `${input.snapshot.workspaceId}:${context.card.id}`;
		if (probing.has(key)) {
			return;
		}
		probing.add(key);
		track(
			(async () => {
				try {
					const result = await deps.probe(target).catch((error: unknown) => ({
						up: false,
						detail: error instanceof Error ? error.message : String(error),
					}));
					// The flow may have moved on while the probe ran (a hand move ended the hold): re-read it.
					const current = latest.get(input.snapshot.workspaceId) ?? input;
					const flow = readRecoveryFlow(current.state.cards[context.card.id]);
					const applied = applyOutageProbe(flow, result.up, current.config.pipeline.recovery, deps.now());
					await deps.updateCards(input.snapshot.workspaceId, new Map([[context.card.id, applied.patch]]));
					await deps.appendRecords([
						{
							...baseRecord(input, context, "recovery"),
							answer: { kind: "probe_result", up: result.up },
							outcome: "acted",
							note: `${applied.reason} (${result.detail})`,
						},
					]);
				} finally {
					probing.delete(key);
				}
			})(),
		);
	};

	const deliver = async (
		workspaceId: string,
		taskId: string,
		text: string,
		clear: string | null,
	): Promise<{ result: RecoveryActionResult; note: string }> => {
		if (clear) {
			const cleared = await deps.act(workspaceId, { kind: "deliver", taskId, text: clear });
			if (!cleared.ok) {
				return {
					result: cleared,
					note: `${clear} not delivered (${cleared.status ?? "?"}: ${cleared.error ?? ""})`,
				};
			}
			await deps.sleep(CLEAR_SETTLE_MS);
		}
		const result = await deps.act(workspaceId, { kind: "deliver", taskId, text });
		const note = !result.ok
			? `not delivered (${result.status ?? "?"}: ${result.error ?? ""})`
			: isConfirmed(result)
				? `delivered (${result.evidence})`
				: `sent, unconfirmed (${result.evidence ?? "no evidence"}): checked again in a while`;
		return { result, note };
	};

	/** Carries out one card's decision. Returns the record outcome and note; adds state patches to `patches`. */
	const act = async (
		input: RecoveryEvaluationInput,
		context: CardContext,
		decision: RecoveryDecision,
		patches: Map<string, RecoveryFlowPatch>,
	): Promise<{ outcome: PipelineDecisionRecord["outcome"]; note: string }> => {
		const { workspaceId } = input.snapshot;
		const taskId = context.card.id;
		const now = new Date(deps.now()).toISOString();
		switch (decision.kind) {
			case "none":
				return { outcome: "none", note: decision.reason };
			case "wait":
				if (decision.patch) {
					patches.set(taskId, decision.patch);
				}
				return { outcome: "none", note: decision.reason };
			case "hold":
				patches.set(taskId, decision.patch);
				return { outcome: "acted", note: decision.reason };
			case "probe":
				startProbe(input, context, decision.target);
				return { outcome: "acted", note: decision.reason };
			case "takeover":
				patches.set(taskId, decision.patch);
				return { outcome: "acted", note: `${decision.reason}; outage hold ended, the rework loop hands it over` };
			case "escalate":
				patches.set(taskId, decision.patch);
				return {
					outcome: "not_implemented",
					note: `escalate: ${decision.reason}${decision.details.length ? ` (${decision.details.join("; ")})` : ""}; recovery stops here, the escalation mechanics (BLOCKED, ATTENTION.md, wake) come with the rework loop`,
				};
			case "cancel_hung": {
				const sent = await deps.act(workspaceId, { kind: "input", taskId, data: decision.input });
				const followUp =
					decision.followUp.kind === "hold"
						? decision.followUp.patch
						: { escalated: { at: now, reason: decision.followUp.reason } };
				patches.set(taskId, { ...decision.patch, ...followUp });
				return {
					outcome: sent.ok ? "acted" : "failed",
					note: `${decision.reason}; cancel ${sent.ok ? "sent" : `FAILED: ${sent.error ?? sent.status}`}; then ${decision.followUp.reason}`,
				};
			}
			case "nudge": {
				let text = decision.text;
				let cleaned: string[] = [];
				if (decision.overflow) {
					const worktree =
						context.session?.workspacePath ??
						(await deps.locateWorktree(input.snapshot.workspacePath, context.card));
					cleaned = worktree ? await deps.cleanGeneratedReports(worktree) : [];
					text = buildPoisonedHistoryPrompt(context.card.prompt, decision.overflow.error, {
						culprit: decision.overflow.culprit,
						cleanedDirs: cleaned,
					});
				}
				const { result, note } = await deliver(workspaceId, taskId, text, decision.clear);
				// The budget counts the attempt either way, so a nudge that never lands still ends in an escalation.
				patches.set(taskId, { ...decision.patch, recoverySentAt: now });
				const cleanNote = cleaned.length > 0 ? `; cleaned ${cleaned.join(", ")}` : "";
				return { outcome: result.ok ? "acted" : "failed", note: `${decision.reason}${cleanNote}; ${note}` };
			}
		}
	};

	/** `plannedNow`: cards evaluateRestart marked as orphans in this evaluation (`input.state` predates the marks). */
	const evaluateCards = async (
		input: RecoveryEvaluationInput,
		acting: boolean,
		plannedNow: ReadonlySet<string>,
	): Promise<PipelineDecisionRecord[]> => {
		const settings = input.config.pipeline.recovery;
		const capacity = input.config.models.providerCapacity;
		const contexts = contextsOf(input);
		const inProgress: CapacityCard[] = contexts
			.filter((context) => context.column === "in_progress")
			.map((context) => ({ taskId: context.card.id, model: context.effective.effective.model }));
		const records: PipelineDecisionRecord[] = [];
		const patches = new Map<string, RecoveryFlowPatch>();
		for (const context of contexts) {
			if (plannedNow.has(context.card.id)) {
				continue; // just marked; its resume is running
			}
			let flow = readRecoveryFlow(input.state.cards[context.card.id]);
			// An orphan mark goes as soon as the card has a session again (resumed, or restarted by hand) or the mark
			// belongs to an earlier server start; otherwise the card would be skipped by recovery and the QA gate forever.
			if (context.column !== "trash" && isOrphanMarkStale(flow, context.session, input.snapshot.serverStartedAt)) {
				if (acting) {
					patches.set(context.card.id, { orphan: null });
				}
				flow = { ...flow, orphan: null };
			}
			if (context.column !== "in_progress" && context.column !== "review") {
				const patch = leftReviewPatch(flow, deps.now());
				if (acting && Object.keys(patch).length > 0) {
					patches.set(context.card.id, patch);
				}
				continue;
			}
			const { effective } = context.effective;
			const detail = effective.role === "dev" ? await readDetail(input, context) : null;
			const worktree = context.session?.workspacePath ?? null;
			const runningTool =
				context.column === "in_progress" &&
				context.session?.state === "running" &&
				worktree &&
				isClineShellToolPending(detail)
					? await deps.findRunningTool(worktree, context.session.pid ?? null)
					: null;
			const decision = decideRecovery({
				card: context.card,
				column: context.column,
				role: effective.role,
				model: effective.model,
				session: context.session,
				detail,
				runningTool,
				readsTurnOutcome: getAgentTurnEndSource(effective.agentId) !== null,
				profile: getAgentRecoveryProfile(effective.agentId),
				flow,
				canProbe: deps.canProbe(effective.model?.provider ?? null),
				capacityHold: findProviderCapacityHold({
					taskId: context.card.id,
					model: effective.model,
					inProgress,
					capacity,
				}),
				slowFirstCall: Boolean(effective.model?.provider && capacity[effective.model.provider]),
				continuesPrematureStops: input.settings.landing.mode === "qa",
				canTakeOver: Boolean(input.takeoverPolicy),
				outageAnswer:
					flow.outage && input.takeoverPolicy && effective.role === "dev"
						? input.takeoverPolicy.onOutage({
								dev: effective,
								heldMin: (deps.now() - Date.parse(flow.outage.since)) / 60_000,
								maxMin: settings.outage.maxMin,
							})
						: null,
				settings,
				reviewSettleMs: input.snapshot.reviewSettleMs,
				now: deps.now(),
			});
			if (decision.kind === "none") {
				continue;
			}
			const { outcome, note } = acting
				? await act(input, context, decision, patches)
				: {
						outcome:
							decision.kind === "wait"
								? ("none" as const)
								: input.config.pipeline.recovery.mode === "on"
									? ("shadow" as const)
									: ("report" as const),
						note: decision.reason,
					};
			records.push({ ...baseRecord(input, context, "recovery"), answer: describeDecision(decision), outcome, note });
		}
		if (acting && patches.size > 0) {
			await deps.updateCards(input.snapshot.workspaceId, patches);
		}
		return records;
	};

	const resumeOrphans = async (
		input: RecoveryEvaluationInput,
		orphans: RestartOrphan[],
		manifestUsed: RestartManifest | null,
	) => {
		const { workspaceId } = input.snapshot;
		const settings = input.config.pipeline.recovery;
		for (const [index, orphan] of orphans.entries()) {
			if (closed) {
				return;
			}
			if (index > 0) {
				await deps.sleep(settings.resumeGapSec * 1000);
			}
			let current = latest.get(workspaceId) ?? input;
			// PID pressure holds new sessions (the legacy recoverOrphans): wait, for as long as it lasts, logged once.
			for (let held = false; !closed && current.snapshot.pidPressure; held = true) {
				if (!held) {
					deps.log(`pipeline ${workspaceId}: restart ${orphan.taskId}: PID pressure; waiting before resuming`);
					await deps.appendRecords([
						{
							...baseRecord(current, null, "restart"),
							taskId: orphan.taskId,
							answer: { kind: "resume" },
							outcome: "none",
							note: "PID pressure; waiting before resuming",
						},
					]);
				}
				await deps.sleep(PRESSURE_RECHECK_MS);
				current = latest.get(workspaceId) ?? current;
			}
			if (closed) {
				return;
			}
			let context = contextsOf(current).find((entry) => entry.card.id === orphan.taskId);
			let heldBy: string | null = null;
			for (let check = 0; context && !closed && check < CAPACITY_MAX_CHECKS; check += 1) {
				const hold = findProviderCapacityHold({
					taskId: orphan.taskId,
					model: context.effective.effective.model,
					inProgress: contextsOf(current)
						.filter((entry) => entry.column === "in_progress" && entry.session?.live)
						.map((entry) => ({ taskId: entry.card.id, model: entry.effective.effective.model })),
					capacity: current.config.models.providerCapacity,
				});
				heldBy = hold ? describeCapacityHold(hold) : null;
				if (!hold) {
					break;
				}
				if (check === 0) {
					deps.log(`pipeline ${workspaceId}: restart ${orphan.taskId}: ${heldBy}`);
				}
				await deps.sleep(CAPACITY_RECHECK_MS);
				current = latest.get(workspaceId) ?? current;
				context = contextsOf(current).find((entry) => entry.card.id === orphan.taskId);
			}
			if (closed) {
				return;
			}
			const record = (outcome: PipelineDecisionRecord["outcome"], note: string, at?: CardContext) => ({
				...baseRecord(current, at ?? null, "restart" as const),
				taskId: orphan.taskId,
				answer: { kind: "resume" },
				outcome,
				note,
			});
			if (!context || (context.column !== "in_progress" && context.column !== "review")) {
				await deps.updateCards(workspaceId, new Map([[orphan.taskId, { orphan: null }]]));
				await deps.appendRecords([record("none", "left In Progress/Review before it was resumed")]);
				continue;
			}
			// Restarted (or finished) by hand while this resume waited: never start a second session over it.
			const { session } = context;
			if (
				session?.live ||
				(session?.startedAt ?? 0) >= (current.snapshot.serverStartedAt ?? Number.POSITIVE_INFINITY)
			) {
				await deps.updateCards(workspaceId, new Map([[orphan.taskId, { orphan: null }]]));
				await deps.appendRecords([
					record("none", "has a live session again (restarted meanwhile); not resumed", context),
				]);
				continue;
			}
			if (heldBy) {
				await deps.appendRecords([
					record("failed", `not resumed: ${heldBy}; by hand: kanban task resume ${orphan.taskId}`, context),
				]);
				continue;
			}
			const worktree = await deps.locateWorktree(current.snapshot.workspacePath, context.card);
			const wipTag = orphan.wipTag ?? (worktree ? await deps.tagRestartWip(worktree, orphan.taskId) : null);
			const hasWip = worktree ? await deps.hasTrackedChanges(worktree) : false;
			const agentId = context.effective.effective.agentId;
			const launch = buildRestartResumeLaunch(agentId, context.card.prompt, hasWip);
			// Before the resume, so the resumed session's activity is newer (recoveryRedoReason).
			const sentAt = new Date(deps.now()).toISOString();
			const result = await deps.act(workspaceId, {
				kind: "resume",
				taskId: orphan.taskId,
				prompt: launch.prompt,
				agentId,
				continueConversation: launch.continueConversation,
			});
			const model = context.effective.effective.model?.model ?? "its default model";
			if (!result.ok) {
				// The orphan mark stays, so nothing nudges a card with no session; `kanban task resume` clears it.
				await deps.appendRecords([
					record(
						"failed",
						`resume FAILED (${result.error ?? result.status ?? "?"}); by hand: kanban task resume ${orphan.taskId}`,
						context,
					),
				]);
				continue;
			}
			await deps.updateCards(
				workspaceId,
				// recoverySentAt: a QA card queued for the interrupted turn is superseded (qa-gate.ts).
				new Map([[orphan.taskId, { orphan: null, liveHold: null, retryAt: null, recoverySentAt: sentAt }]]),
			);
			await deps.appendRecords([
				record(
					"acted",
					`resumed on ${model} (${wipTag ? `WIP tag ${wipTag}` : "no WIP tag"}${orphan.earlierWipTag ? `; the manifest's earlier tag ${orphan.earlierWipTag} not reused` : ""}${launch.continueConversation ? ", conversation continued" : hasWip ? ", WIP note" : ", fresh"}); no FAIL round, nudge or escalation counted`,
					context,
				),
			]);
		}
		if (manifestUsed) {
			await deps.removeManifest(workspaceId, manifestUsed);
		}
	};

	const orphanMarks = (orphans: RestartOrphan[], serverStartedAt: number): Map<string, RecoveryFlowPatch> => {
		const at = new Date(deps.now()).toISOString();
		const kanbanStart = new Date(serverStartedAt).toISOString();
		return new Map(orphans.map((orphan) => [orphan.taskId, { orphan: { at, kanbanStart, kind: orphan.role } }]));
	};

	const evaluateRestart = async (
		input: RecoveryEvaluationInput,
		acting: boolean,
		plannedNow: Set<string>,
	): Promise<PipelineDecisionRecord[]> => {
		const { workspaceId, serverStartedAt } = input.snapshot;
		if (serverStartedAt === undefined) {
			return [];
		}
		// A recover request that comes in during a resume stays queued for the next evaluation after it.
		if (recovering.has(workspaceId)) {
			return [];
		}
		const asked = await deps.consumeRecoverRequest(workspaceId);
		if (handledStarts.get(workspaceId) === serverStartedAt && !asked) {
			return [];
		}
		handledStarts.set(workspaceId, serverStartedAt);
		const contexts = contextsOf(input);
		const ended = new Set<string>();
		for (const context of contexts) {
			// "interrupted" too: the server marks a "running" summary whose process died with the old server interrupted
			// when it loads it (markOrphanedSessionsInterrupted), which may be before this plan.
			const state = context.session?.state;
			if (
				(context.column === "in_progress" || context.column === "review") &&
				(state === "running" || state === "interrupted") &&
				!context.session?.live
			) {
				const detail = await readDetail(input, context);
				const decision = evaluateClineTurnEnd({
					session: detail?.snapshot ?? null,
					runningSince: null,
					now: deps.now(),
					requireStatus: false,
				});
				if (decision.ended) {
					ended.add(context.card.id);
				}
			}
		}
		const manifest = await deps.readManifest(workspaceId);
		const plan = planRestartRecovery({
			cards: contexts.map((context) => ({ card: context.card, column: context.column })),
			sessions: new Map(input.snapshot.sessions.map((session) => [session.taskId, session])),
			serverStartedAt,
			previousServerStartedAt: input.snapshot.previousServerStartedAt ?? null,
			manifest,
			turnEnded: (card) => ended.has(card.id),
		});
		// A manifest that isn't this start's (no start used it, or it predates the previous server) is never replayed.
		// One this very server wrote (src/server/restart-manifest-writer.ts) is for the next start: left alone.
		const ownManifest = manifest?.kanbanStart ? Date.parse(manifest.kanbanStart) === serverStartedAt : false;
		const staleManifest = manifest !== null && plan.manifestAt === null && !ownManifest;
		if (staleManifest) {
			await deps.removeManifest(workspaceId, manifest);
		}
		const usedManifest = plan.manifestAt !== null ? manifest : null;
		const byId = new Map(contexts.map((context) => [context.card.id, context]));
		const notActing = input.config.pipeline.recovery.mode === "on" ? "shadow" : "report";
		const records: PipelineDecisionRecord[] = [
			{
				...baseRecord(input, null, "restart"),
				answer: null,
				outcome: "none",
				note: `Kanban started ${new Date(serverStartedAt).toISOString()}${asked ? " (check asked for)" : ""}: ${plan.orphans.length} orphaned card(s)${plan.manifestAt ? `; restart manifest of ${plan.manifestAt}` : ""}${staleManifest ? `; dropped a stale restart manifest of ${manifest?.at}` : ""}`,
			},
		];
		const devOrphans = plan.orphans.filter((orphan) => orphan.role === "dev");
		// An orphaned QA card is never resumed: its replacement is the QA gate's, which creates and starts QA cards
		// within its slots and PID pressure. Recovery hands the gate's own QA cards over with an orphan mark; the gate
		// supersedes them (qa-gate.ts describeDeadQaCard reads its session too, so it does this without the mark in
		// report mode) and queues a new QA card for the same snapshot. A legacy-kit QA card stays the legacy kit's.
		const qaOrphans: RestartOrphan[] = [];
		for (const orphan of plan.orphans) {
			const context = byId.get(orphan.taskId) ?? null;
			if (orphan.role === "dev") {
				records.push({
					...baseRecord(input, context, "restart"),
					taskId: orphan.taskId,
					answer: { kind: "resume" },
					outcome: acting ? "acted" : notActing,
					note: `orphaned (${orphan.column}): ${orphan.reason}; ${acting ? "resuming" : "would resume"} on the same model`,
				});
				continue;
			}
			const gate = readQaGateEntry(input.state.cards[orphan.taskId]);
			const record = {
				...baseRecord(input, context, "restart"),
				taskId: orphan.taskId,
				answer: { kind: "recreate_qa" },
			};
			if (!gate || (gate.status !== "queued" && gate.status !== "running")) {
				records.push({
					...record,
					outcome: "none",
					note: `orphaned QA card (${orphan.column}): ${orphan.reason}; ${gate ? `its QA gate entry is ${gate.status}` : "not made by the QA gate (the legacy kit's)"}, so it is left alone`,
				});
				continue;
			}
			qaOrphans.push(orphan);
			const replacement = `a new QA card for ${gate.reviewsTaskId}'s snapshot ${gate.snapshot.slice(0, 8)} (QA slots and PID pressure apply)`;
			records.push({
				...record,
				outcome: acting ? "acted" : notActing,
				note: `orphaned QA card (${orphan.column}): ${orphan.reason}; ${acting ? `handed to the QA gate, which supersedes it and queues ${replacement}` : `the QA gate supersedes it on its own and queues ${replacement}`}`,
			});
		}
		// Marks from an earlier plan that this one doesn't list (resumed, finished or moved since) go.
		const planned = new Set([...devOrphans, ...qaOrphans].map((orphan) => orphan.taskId));
		const staleMarks = acting
			? Object.entries(input.state.cards)
					.filter(([taskId, entry]) => !planned.has(taskId) && readRecoveryFlow(entry).orphan)
					.map(([taskId]) => [taskId, { orphan: null }] as [string, RecoveryFlowPatch])
			: [];
		if (staleMarks.length > 0) {
			await deps.updateCards(workspaceId, new Map(staleMarks));
		}
		if (acting && qaOrphans.length > 0) {
			await deps.updateCards(workspaceId, orphanMarks(qaOrphans, serverStartedAt));
		}
		if (acting && devOrphans.length > 0) {
			await deps.updateCards(workspaceId, orphanMarks(devOrphans, serverStartedAt));
			for (const orphan of devOrphans) {
				plannedNow.add(orphan.taskId);
			}
			recovering.add(workspaceId);
			// Removed once the resumes are done; until then the running server's writer may replace it.
			if (usedManifest) {
				await deps.markManifestPlanned(workspaceId, usedManifest);
			}
			track(
				resumeOrphans(input, devOrphans, usedManifest).finally(() => {
					recovering.delete(workspaceId);
				}),
			);
		} else if (usedManifest) {
			// A manifest is for the next start only: once planned, it goes in report mode too.
			await deps.removeManifest(workspaceId, usedManifest);
		}
		return plan.orphans.length > 0 || asked || staleManifest ? records : [];
	};

	return {
		evaluate: async (input) => {
			const scope = getRecoveryScope(input.config, input.settings);
			if (!scope.evaluate || closed) {
				return [];
			}
			latest.set(input.snapshot.workspaceId, input);
			const plannedNow = new Set<string>();
			const restart = await evaluateRestart(input, scope.act, plannedNow);
			return [...restart, ...(await evaluateCards(input, scope.act, plannedNow))];
		},
		forget: (workspaceId) => {
			latest.delete(workspaceId);
			handledStarts.delete(workspaceId);
		},
		idle: async () => {
			await Promise.all([...background]);
		},
		close: () => {
			closed = true;
		},
	};
}
