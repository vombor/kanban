// Recovery decisions for one card (plan §2.6 "crash nudges, premature stop, poisoned history, hung-request cancel,
// transient retry, outage hold"). Pure: the caller (recovery-stage.ts) reads the evidence, passes the clock, and
// acts on the answer. The answer carries the state change (`patch`, merged into the card's `qaflow` entry of
// pipeline-state.json under the legacy kit's key names, so the state file copies across at cutover) to write once
// the action succeeded.
//
// The order is autoland's (archive/devteam-kit:services/kanban-autoland.mjs@6da71597 qaflowSweep, onDevReview,
// nudgeIfErrored, providerHold, sendDueRetry, checkOutage, checkHung):
//   in_progress: a hung model request → Esc, then the provider-error path; a silent stall (the session runs but its
//                file shows no progress for `stallNudgeMin`) → a nudge, within the nudge budget.
//   review:      orphaned by a restart → restart recovery owns it; a live session → hold (no nudge, no QA);
//                an outage hold → probe; a due retry → continue; then why the turn stopped:
//                STATUS BLOCKED/NEEDS_INPUT → escalate, STATUS DONE → finished,
//                a provider error → backoff retry, then the outage hold (if the provider has a probe),
//                a poisoned history → /clear + the card prompt, any other error → a crash nudge,
//                no error but a premature stop → "continue" (or /clear + the prompt for an empty reply).
//
// Only agents whose adapter says where a turn's outcome can be read (`turnEndSource`, today the Cline CLI's
// session files) get the stop/hung checks: for the others Kanban's summary doesn't say why a turn stopped. A
// session without a live process is never nudged (there is no TUI to type into); restart recovery resumes those.
// Escalation itself (BLOCKED + Backlog, ATTENTION.md, the orchestrator wake) is the rework loop's mechanics
// (P4-5); recovery records the escalation and stops touching the card. So is a takeover: when the kit's `onOutage`
// says so, an outage hold ends with `qaflow.takeover`, and the rework loop hands the task to the kit's escalation
// target (a sibling card on that model) in the same evaluation.
import type { PipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardCard, RuntimeTaskRole } from "../core/api-contract";
import type { EffectiveModel } from "../core/effective-agent";
import type { EscalationTarget, OnOutageAnswer } from "../kits/policy";
import type { AgentRecoveryProfile } from "../terminal/agent-session-adapters";
import type { ClineSessionDetail } from "../terminal/cline-session-files";
import {
	type ClineSilentStall,
	describeClineSilentStall,
	evaluateClineSilentStall,
	getSessionProgressAt,
	isClineSessionOfRun,
} from "../terminal/cline-turn-check";
import { getClineFinalReplyText, parseClineStatusLine } from "../terminal/cline-turn-outcome";
import { getReviewActivityAt, isReviewSettled, type ReviewSettleSession } from "../terminal/review-settle";
import type { PipelineSessionView } from "./engine";
import type { ProviderCapacityHold } from "./provider-capacity";
import {
	detectFinalProviderError,
	detectHungRequest,
	detectPrematureStop,
	findOverflowCulprit,
	isContextOverflowError,
	isPoisonedHistoryError,
	isTransientProviderError,
	type PrematureStop,
} from "./recovery-detect";
import {
	buildClearedPrematurePrompt,
	buildCrashNudgePrompt,
	buildPoisonedHistoryPrompt,
	buildProviderRetryPrompt,
	buildSilentStallPrompt,
	CONTINUE_PROMPT,
} from "./recovery-prompts";
import { isReworkAwaitingStart, type OpenRework, readOpenRework } from "./rework-state";

export type RecoverySettings = PipelineConfig["pipeline"]["recovery"];

/** A session's Cline file is "still being written" for this long (c5c42ec: a false Review flip, bfb20). */
const LIVE_WRITE_MS = 2 * 60_000;
/** After a good outage probe, the confirming probe follows this soon (692f174: one good probe was a flap). */
const CONFIRM_PROBE_MS = 60_000;

interface StampedEntry {
	at: string;
}

/** The recovery fields of a card's `qaflow` entry (the legacy kit's names). */
export interface RecoveryFlowState {
	nudges: Array<StampedEntry & { reason: string; poisoned: boolean; warn: string }>;
	continues: Array<StampedEntry & { said: string }>;
	transient: Array<StampedEntry & { warn: string }>;
	retryAt: string | null;
	outage: { since: string; model: string; warn: string; ups: number; lastProbe: string | null } | null;
	outages: unknown[];
	outageEndedAt: string | null;
	/** An outage hold the kit hands to another model (`onOutage`); the rework loop carries it out and clears it. */
	takeover: RecoveryTakeoverRequest | null;
	hung: { dir: string; lastWrite: number; at: string } | null;
	liveHold: string | null;
	orphan: { at: string; kanbanStart: string; kind: RuntimeTaskRole } | null;
	/** Set by escalation (the rework loop, or recovery); recovery leaves an escalated card alone. */
	escalated: { at: string; reason: string } | null;
	/** When recovery last typed into the card (Kanban's own field; the legacy kit didn't need it). */
	recoverySentAt: string | null;
	/** The rework stage's newest unreturned rework (rework-state.ts); a fresh one not seen started is its card. */
	openRework: OpenRework | null;
	/** The newest of these restarts the nudge/continue/retry budgets (sinceBudget). */
	resetAt: string | null;
	/** When the rework stage last sent a rework: a rework starts the budgets afresh, like a verdict. */
	lastReworkAt: string | null;
	lastVerdictAt: string | null;
	handbacks: StampedEntry[];
}

/** `qaflow.takeover`: recovery's request to hand a held card's task to the kit's escalation target. */
export interface RecoveryTakeoverRequest {
	at: string;
	cause: "outage";
	reason: string;
	to: Exclude<EscalationTarget, "orchestrator">;
	requireApproval: boolean;
	details: string[];
}

export type RecoveryFlowPatch = Partial<RecoveryFlowState>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stampedList<T extends StampedEntry>(value: unknown): T[] {
	return Array.isArray(value) ? (value.filter((entry) => isRecord(entry) && typeof entry.at === "string") as T[]) : [];
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function recordOrNull<T>(value: unknown): T | null {
	return isRecord(value) ? (value as T) : null;
}

/**
 * The newest QA verdict time, ISO: the legacy `qaflow.lastVerdictAt` or the QA gate's newest `qaVerdicts[].at`
 * (epoch ms, written at ingest). Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (sinceBudget
 * counts from the newest QA verdict's time, so a rework starts with fresh nudge/continue/retry budgets).
 */
function newestVerdictAt(legacy: string | null, verdicts: unknown): string | null {
	const times = (Array.isArray(verdicts) ? verdicts : [])
		.map((verdict) => (isRecord(verdict) && typeof verdict.at === "number" ? verdict.at : Number.NaN))
		.filter((at) => Number.isFinite(at));
	const newest = times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
	return (
		[legacy, newest]
			.filter((at): at is string => Boolean(at))
			.sort()
			.at(-1) ?? null
	);
}

function readTakeoverRequest(value: unknown): RecoveryTakeoverRequest | null {
	if (!isRecord(value) || typeof value.at !== "string" || !isRecord(value.to) || !isRecord(value.to.model)) {
		return null;
	}
	return value as unknown as RecoveryTakeoverRequest;
}

/** Reads the recovery fields of a pipeline-state card entry; missing or malformed fields read as empty. */
export function readRecoveryFlow(entry: Record<string, unknown> | undefined): RecoveryFlowState {
	const flow = isRecord(entry?.qaflow) ? entry.qaflow : {};
	const escalated = flow.escalated;
	return {
		nudges: stampedList(flow.nudges),
		continues: stampedList(flow.continues),
		transient: stampedList(flow.transient),
		retryAt: stringOrNull(flow.retryAt),
		outage: recordOrNull(flow.outage),
		outages: Array.isArray(flow.outages) ? flow.outages : [],
		outageEndedAt: stringOrNull(flow.outageEndedAt),
		takeover: readTakeoverRequest(flow.takeover),
		hung: recordOrNull(flow.hung),
		liveHold: stringOrNull(flow.liveHold),
		orphan: recordOrNull(flow.orphan),
		escalated: escalated
			? isRecord(escalated)
				? {
						at: String(escalated.at ?? ""),
						reason: String(escalated.reason ?? ""),
					}
				: { at: "", reason: "escalated" }
			: null,
		recoverySentAt: stringOrNull(flow.recoverySentAt),
		openRework: readOpenRework(flow),
		resetAt: stringOrNull(flow.resetAt),
		lastReworkAt: stringOrNull(flow.lastReworkAt),
		lastVerdictAt: newestVerdictAt(stringOrNull(flow.lastVerdictAt), entry?.qaVerdicts),
		handbacks: stampedList(flow.handbacks),
	};
}

/** Entries made since the last verdict, rework, handback or fresh restart: those count against a budget. */
export function sinceBudget<T extends StampedEntry>(list: readonly T[], flow: RecoveryFlowState): T[] {
	const marks = [flow.lastVerdictAt, flow.lastReworkAt, flow.handbacks.at(-1)?.at ?? null, flow.resetAt]
		.filter((mark): mark is string => Boolean(mark))
		.sort();
	const since = marks.at(-1);
	return since ? list.filter((entry) => entry.at > since) : [...list];
}

export interface RecoveryCardInput {
	card: RuntimeBoardCard;
	column: "in_progress" | "review";
	role: RuntimeTaskRole;
	model: EffectiveModel | null;
	session: PipelineSessionView | null;
	/** The newest Cline CLI session of the card's worktree, for agents whose turn outcome is in session files. */
	detail: ClineSessionDetail | null;
	/** The adapter says where a turn's outcome can be read (`turnEndSource`). */
	readsTurnOutcome: boolean;
	/**
	 * The turn outcome is in Cline-style session files (`detail`), so a running session with none of its own is a
	 * `no_session` stall (its TUI never took the prompt).
	 */
	readsSessionFiles?: boolean;
	/** For a `no_session` stall: why Cline's TUI would open its sign-in screen (cline-tui-sign-in.ts), when known. */
	signInGap?: string | null;
	profile: AgentRecoveryProfile;
	flow: RecoveryFlowState;
	/** The card's provider has a probe (models probe), so an outage can be held and probed. */
	canProbe: boolean;
	/** Set when the provider is at its `maxLoadedModels` with other models. */
	capacityHold: ProviderCapacityHold | null;
	/**
	 * The provider loads a model on the first request (it has a `maxLoadedModels` limit, e.g. Lemonade), so the
	 * first call gets `hungFirstMin` before it counts as hung.
	 */
	slowFirstCall: boolean;
	/**
	 * A process the card's agent started (a shell tool's command) still runs in the worktree, e.g. `npm test`; set
	 * only while a shell tool call is pending (isClineShellToolPending). Its step isn't stalled however long it takes.
	 */
	runningTool?: string | null;
	/**
	 * Premature-stop continues (an announcement, an empty reply, a rejected image) are part of the QA flow: only on
	 * landing-`qa` workspaces. Crash nudges, provider retries, outage holds and hung cancels run on any recovery
	 * workspace (plan §12: recovery on `default` projects continues a crashed card).
	 */
	continuesPrematureStops: boolean;
	/**
	 * The rework loop runs for the workspace (landing `qa`, not shadow), so a takeover request is carried out. Without
	 * it a pending request goes to the orchestrator.
	 */
	canTakeOver?: boolean;
	/** The kit's `onOutage` answer for a card in an outage hold, asked only when `canTakeOver`. */
	outageAnswer?: OnOutageAnswer | null;
	settings: RecoverySettings;
	/** The snapshot's `reviewSettleMs` (isReviewSettled); absent: the default. */
	reviewSettleMs?: number;
	now: number;
}

export type RecoveryNudgeCause = "crash" | "poisoned" | "premature" | "retry" | "silent_stall";

export type RecoveryDecision =
	/** Nothing for recovery to do. */
	| { kind: "none"; reason: string }
	/** Not now; decided again on a later evaluation. A patch, when present, is state-only (no action). */
	| { kind: "wait"; reason: string; patch?: RecoveryFlowPatch }
	/** Type into the TUI (after `clear` when set), then move the card to In Progress. */
	| {
			kind: "nudge";
			cause: RecoveryNudgeCause;
			reason: string;
			clear: string | null;
			text: string;
			/** Clean gitignored generated reports first and say so in the text (context overflow). */
			overflow: { error: string; culprit: { size: number; query: string | null } | null } | null;
			patch: RecoveryFlowPatch;
	  }
	/** Schedule a provider-error retry or start an outage hold: state only, the card stays in Review. */
	| { kind: "hold"; reason: string; patch: RecoveryFlowPatch }
	/** Probe the card's model for an outage hold; recovery-stage applies the result with applyOutageProbe(). */
	| { kind: "probe"; reason: string; target: EffectiveModel }
	/** Cancel a hung request (type `input`), then move the card to Review with `followUp` applied. */
	| {
			kind: "cancel_hung";
			reason: string;
			input: string;
			patch: RecoveryFlowPatch;
			followUp: { kind: "hold"; reason: string; patch: RecoveryFlowPatch } | { kind: "escalate"; reason: string };
	  }
	/** End the outage hold and ask the rework loop to hand the task to the kit's target (`qaflow.takeover`). */
	| { kind: "takeover"; reason: string; to: RecoveryTakeoverRequest["to"]; patch: RecoveryFlowPatch }
	| { kind: "escalate"; reason: string; details: string[]; patch: RecoveryFlowPatch };

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function modelLabel(model: EffectiveModel | null): string {
	return model ? (model.provider ? `${model.provider}/${model.model}` : model.model) : "its default model";
}

function escalate(input: RecoveryCardInput, reason: string, details: string[] = [], patch: RecoveryFlowPatch = {}) {
	return {
		kind: "escalate" as const,
		reason,
		details,
		patch: { ...patch, escalated: { at: iso(input.now), reason } },
	};
}

/**
 * The provider-error path (daf86a5, 692f174): a backoff retry while retries are left (outside the nudge budget,
 * QA held), then an outage hold with probes when the provider has a probe. Null when neither applies.
 */
function providerHold(
	input: RecoveryCardInput,
	warn: string,
	extraPatch: RecoveryFlowPatch = {},
): { kind: "hold"; reason: string; patch: RecoveryFlowPatch } | null {
	if (!isTransientProviderError(warn)) {
		return null;
	}
	const { flow, settings, now } = input;
	const backoff = settings.retryBackoffMin;
	const streak = sinceBudget(flow.transient, flow).filter(
		(entry) => !flow.outageEndedAt || entry.at > flow.outageEndedAt,
	);
	const label = modelLabel(input.model);
	if (streak.length < backoff.length) {
		const waitMin = backoff[streak.length] ?? backoff.at(-1) ?? 1;
		const retryAt = iso(now + waitMin * 60_000);
		return {
			kind: "hold",
			reason: `provider error on ${label} (${streak.length + 1}/${backoff.length}); retrying in ${waitMin} min; no QA. ${warn.slice(0, 120)}`,
			patch: {
				...extraPatch,
				retryAt,
				transient: [...flow.transient, { at: iso(now), warn: warn.slice(0, 200) }],
			},
		};
	}
	if (!input.canProbe || !input.model) {
		return null;
	}
	const { outage } = settings;
	return {
		kind: "hold",
		reason: `provider retries used up on ${label}; outage hold, probing every ${outage.probeEveryMin} min (resume after ${outage.upsToResume} good probes in a row, escalate after ${outage.maxMin} min); no QA`,
		patch: {
			...extraPatch,
			outage: { since: iso(now), model: label, warn: warn.slice(0, 200), ups: 0, lastProbe: null },
		},
	};
}

/** Whether the card's agent is still working (a false Review flip): live process, running, and still writing. */
function isWorking(input: RecoveryCardInput): boolean {
	const { session, detail, now } = input;
	if (!session?.live || session.state !== "running") {
		return false;
	}
	if (!input.readsTurnOutcome) {
		return true;
	}
	const lastWrite = Math.max(detail?.lastWriteAt ?? 0, detail?.snapshot.messagesWrittenAt ?? 0);
	return detail?.snapshot.status === "running" && now - lastWrite < LIVE_WRITE_MS;
}

function outageDecision(input: RecoveryCardInput): RecoveryDecision {
	const outage = input.flow.outage;
	if (!outage) {
		return { kind: "none", reason: "no outage" };
	}
	const { settings, now } = input;
	const sinceMs = Date.parse(outage.since);
	// Asked first: a takeover at maxMin (the kit's default afterMin) wins over giving up to the orchestrator.
	const answer = input.canTakeOver ? input.outageAnswer : null;
	if (answer?.action === "escalate") {
		const target = `${answer.to.agentId} on ${modelLabel(answer.to.model)}`;
		const takeover: RecoveryTakeoverRequest = {
			at: iso(now),
			cause: "outage",
			reason: answer.reason,
			to: answer.to,
			requireApproval: answer.requireApproval,
			details: [`last error: ${outage.warn}`],
		};
		return {
			kind: "takeover",
			reason: `${answer.reason}: the kit hands the task to ${target}`,
			to: answer.to,
			patch: { ...endOutagePatch(input.flow, now, `taken over by ${target}`), takeover },
		};
	}
	if (now - sinceMs > settings.outage.maxMin * 60_000) {
		return escalate(
			input,
			`provider outage: ${outage.model} still failing after ${settings.outage.maxMin} min of probes`,
			[`last error: ${outage.warn}`],
			endOutagePatch(input.flow, now, "gave up"),
		);
	}
	const lastProbe = outage.lastProbe ? Date.parse(outage.lastProbe) : null;
	const every = outage.ups > 0 ? CONFIRM_PROBE_MS : settings.outage.probeEveryMin * 60_000;
	if (lastProbe !== null && now - lastProbe < every) {
		return { kind: "wait", reason: `outage hold on ${outage.model}: next probe at ${iso(lastProbe + every)}` };
	}
	if (!input.model) {
		return { kind: "wait", reason: `outage hold on ${outage.model}: the card has no model to probe` };
	}
	return { kind: "probe", reason: `outage hold on ${outage.model}: probing`, target: input.model };
}

function endOutagePatch(flow: RecoveryFlowState, now: number, result: string): RecoveryFlowPatch {
	const at = iso(now);
	return { outage: null, outageEndedAt: at, outages: [...flow.outages, { ...flow.outage, ended: at, result }] };
}

/** The state change after an outage probe: confirm, resume (a due retry with fresh provider retries), or reset. */
export function applyOutageProbe(
	flow: RecoveryFlowState,
	up: boolean,
	settings: RecoverySettings,
	now: number,
): { patch: RecoveryFlowPatch; resumed: boolean; reason: string } {
	const outage = flow.outage;
	if (!outage) {
		return { patch: {}, resumed: false, reason: "no outage hold" };
	}
	const ups = up ? outage.ups + 1 : 0;
	if (up && ups >= settings.outage.upsToResume) {
		const minutes = Math.round((now - Date.parse(outage.since)) / 60_000);
		return {
			patch: { ...endOutagePatch(flow, now, "model up"), retryAt: iso(now) },
			resumed: true,
			reason: `${outage.model} answers again (${ups} good probes); outage over after ${minutes} min, resuming with fresh provider retries`,
		};
	}
	return {
		patch: { outage: { ...outage, ups, lastProbe: iso(now) } },
		resumed: false,
		reason: `outage probe of ${outage.model}: ${up ? `up (${ups}/${settings.outage.upsToResume})` : "down"}`,
	};
}

function stopReason(input: RecoveryCardInput): { error: string; reason: string } | null {
	const { detail, session } = input;
	const messages = detail?.messages ?? [];
	const replyError = detectFinalProviderError(messages);
	if (replyError) {
		return { error: replyError, reason: "error" };
	}
	if (detail?.snapshot.status === "failed") {
		return { error: "the Cline session failed", reason: "error" };
	}
	if (session?.reviewReason === "error") {
		return { error: session.latestHookActivity?.finalMessage?.trim() || "agent error (no message)", reason: "error" };
	}
	return null;
}

function nudgeForPremature(input: RecoveryCardInput, stop: PrematureStop): RecoveryDecision {
	const { flow, settings, now } = input;
	const said =
		stop.kind === "empty"
			? stop.outputCap
				? "(empty model reply: output cap)"
				: "(empty model reply)"
			: stop.kind === "no_images"
				? stop.tooLarge
					? "(model rejects an image over its size limits)"
					: "(model rejects images)"
				: stop.text;
	const used = sinceBudget(flow.continues, flow);
	const label = modelLabel(input.model);
	if (used.length >= settings.maxContinues) {
		return escalate(input, `agent keeps ending turns without acting (${used.length} continues, ${label})`, [
			`last reply: ${said}`,
		]);
	}
	const patch: RecoveryFlowPatch = { continues: [...flow.continues, { at: iso(now), said }] };
	if (stop.kind === "announcement") {
		return {
			kind: "nudge",
			cause: "premature",
			reason: `turn ended on an announcement without a tool call; continue ${used.length + 1}/${settings.maxContinues} to ${label}: "${said.slice(-80)}"`,
			clear: null,
			text: CONTINUE_PROMPT,
			overflow: null,
			patch,
		};
	}
	const clear = input.profile.clearContextCommand;
	if (!clear) {
		return escalate(input, `${said} on ${label}, and the agent has no command to clear its conversation`);
	}
	return {
		kind: "nudge",
		cause: "premature",
		reason: `${said}: clear the conversation and resend the card prompt (${used.length + 1}/${settings.maxContinues}, ${label})`,
		clear,
		text: buildClearedPrematurePrompt(input.card.prompt, stop),
		overflow: null,
		patch,
	};
}

function nudgeForError(input: RecoveryCardInput, stop: { error: string; reason: string }): RecoveryDecision {
	const { flow, settings, now } = input;
	const hold = providerHold(input, stop.error);
	if (hold) {
		return hold;
	}
	const used = sinceBudget(flow.nudges, flow);
	const label = modelLabel(input.model);
	if (used.length >= settings.maxNudges) {
		return escalate(input, `agent stopped with ${stop.reason} ${used.length + 1} times (${label})`, [
			`last error: ${stop.error}`,
		]);
	}
	const poisoned = isPoisonedHistoryError(stop.error);
	const clear = poisoned ? input.profile.clearContextCommand : null;
	if (poisoned && !clear) {
		return escalate(input, `the conversation is poisoned (${stop.error.slice(0, 120)}) and the agent can't clear it`);
	}
	const overflow =
		poisoned && isContextOverflowError(stop.error)
			? { error: stop.error, culprit: findOverflowCulprit(input.detail?.messages ?? []) }
			: null;
	return {
		kind: "nudge",
		cause: poisoned ? "poisoned" : "crash",
		reason: `agent stopped with ${stop.reason}${poisoned ? " (corrupted history: clear + full prompt)" : ""}; nudge ${used.length + 1}/${settings.maxNudges} to ${label}. ${stop.error.slice(0, 120)}`,
		clear,
		text: poisoned
			? buildPoisonedHistoryPrompt(
					input.card.prompt,
					stop.error,
					overflow ? { culprit: overflow.culprit, cleanedDirs: [] } : null,
				)
			: buildCrashNudgePrompt(stop.reason, stop.error),
		overflow,
		patch: {
			nudges: [...flow.nudges, { at: iso(now), reason: stop.reason, poisoned, warn: stop.error.slice(0, 200) }],
		},
	};
}

/** A pending provider-error retry or outage hold, in either column (a cancelled hung request stays In Progress). */
function decidePendingHold(input: RecoveryCardInput, clearHold: RecoveryFlowPatch): RecoveryDecision | null {
	const { flow, now } = input;
	if (flow.outage) {
		return outageDecision(input);
	}
	if (flow.retryAt) {
		const due = Date.parse(flow.retryAt);
		if (due > now) {
			return { kind: "wait", reason: `provider-error retry due at ${flow.retryAt}` };
		}
		if (input.capacityHold) {
			return { kind: "wait", reason: describeCapacityHold(input.capacityHold) };
		}
		const last = flow.transient.at(-1)?.warn ?? "provider error";
		return {
			kind: "nudge",
			cause: "retry",
			reason: `provider-error retry (${flow.transient.length}) to ${modelLabel(input.model)}`,
			clear: null,
			text: buildProviderRetryPrompt(last),
			overflow: null,
			patch: { ...clearHold, retryAt: null },
		};
	}
	return null;
}

function decideReview(input: RecoveryCardInput): RecoveryDecision {
	const { flow, now, settings } = input;
	if (isWorking(input)) {
		const dir = input.detail?.snapshot.sessionId ?? "session";
		return {
			kind: "wait",
			reason: `in Review but ${dir} is still running; no nudge, no QA until it ends`,
			...(flow.liveHold !== dir ? { patch: { liveHold: dir } } : {}),
		};
	}
	// A turn that ended moments ago may resume on its own (src/terminal/review-settle.ts): nothing is typed into it
	// until its Review has settled. Only awaiting_review waits: a "running" summary that isn't working (an idle
	// Cline TUI, a lost process) is what recovery is for.
	if (input.session?.state === "awaiting_review" && !isReviewSettled(input.session, now, input.reviewSettleMs)) {
		return { kind: "wait", reason: "the turn ended moments ago; waiting for the Review to settle" };
	}
	const clearHold: RecoveryFlowPatch = flow.liveHold ? { liveHold: null } : {};
	const pending = decidePendingHold(input, clearHold);
	if (pending) {
		return pending;
	}
	if (!input.readsTurnOutcome) {
		return {
			kind: "none",
			reason: "the agent's turn outcome is not readable (no session files); nothing to recover",
		};
	}
	if (!input.session?.live) {
		return { kind: "none", reason: "no live session to type into" };
	}
	if (flow.recoverySentAt && now - Date.parse(flow.recoverySentAt) < settings.nudgeCheckSec * 1000) {
		return { kind: "wait", reason: `waiting for the agent to pick up the message sent at ${flow.recoverySentAt}` };
	}
	const messages = input.detail?.messages ?? [];
	const finalText = input.detail ? getClineFinalReplyText(input.detail.snapshot.lastMessage) : null;
	const status = finalText ? parseClineStatusLine(finalText) : null;
	// ebde195: the STATUS line decides for every model. DONE goes to QA as is; BLOCKED / NEEDS_INPUT escalate.
	if (status && status.kind !== "DONE") {
		return escalate(input, `agent reported ${status.kind}: ${status.detail || "no detail"}`.slice(0, 300), [
			`session ${input.detail?.snapshot.sessionId ?? "?"}`,
		]);
	}
	if (status) {
		return flow.transient.length > 0 || flow.liveHold
			? {
					kind: "wait",
					reason: "finished (STATUS: DONE); provider-error streak cleared",
					patch: { ...clearHold, transient: [] },
				}
			: { kind: "none", reason: "finished (STATUS: DONE)" };
	}
	const premature = input.continuesPrematureStops ? detectPrematureStop(messages) : null;
	// An image rejection reads as a poisoned-history error too ("messages.1.content.86.image…"): it gets the image
	// note instead, or the cleared conversation opens the same image again (issue #12).
	const stop = premature?.kind === "no_images" ? null : stopReason(input);
	if (stop) {
		if (input.capacityHold) {
			return { kind: "wait", reason: describeCapacityHold(input.capacityHold) };
		}
		return withPatch(nudgeForError(input, stop), clearHold);
	}
	if (!premature) {
		return flow.liveHold
			? { kind: "wait", reason: "the held session ended normally", patch: clearHold }
			: { kind: "none", reason: "the turn ended normally" };
	}
	if (input.capacityHold) {
		return { kind: "wait", reason: describeCapacityHold(input.capacityHold) };
	}
	return withPatch(nudgeForPremature(input, premature), clearHold);
}

function withPatch(decision: RecoveryDecision, extra: RecoveryFlowPatch): RecoveryDecision {
	if (Object.keys(extra).length === 0 || !("patch" in decision)) {
		return decision;
	}
	return { ...decision, patch: { ...extra, ...decision.patch } } as RecoveryDecision;
}

export function describeCapacityHold(hold: ProviderCapacityHold): string {
	return `${hold.provider} holds ${hold.maxLoadedModels} model(s) already (${hold.holders.join(", ")}); waiting for it`;
}

function decideInProgress(input: RecoveryCardInput): RecoveryDecision {
	const { flow, session, detail, settings, now } = input;
	if (flow.retryAt || flow.outage) {
		return isWorking(input)
			? { kind: "none", reason: "working again with a provider-error retry or outage hold pending" }
			: (decidePendingHold(input, {}) ?? { kind: "none", reason: "no pending hold" });
	}
	if (
		input.readsSessionFiles &&
		session?.live &&
		session.state === "running" &&
		!isClineSessionOfRun(detail, session.startedAt ?? null)
	) {
		return decideNoSession(input);
	}
	if (!input.readsTurnOutcome || !detail || !session?.live || session.state !== "running") {
		return { kind: "none", reason: "no live session with readable turns" };
	}
	const cancel = input.profile.cancelTurnInput;
	const hung = cancel
		? detectHungRequest(detail, {
				now,
				hungMin: settings.hungMin,
				hungFirstMin: settings.hungFirstMin,
				slowFirstCall: input.slowFirstCall,
			})
		: null;
	if (!cancel || !hung) {
		return decideSilentStall(input, Boolean(cancel));
	}
	if (flow.hung?.dir === hung.sessionId && flow.hung.lastWrite === hung.lastWriteAt) {
		return { kind: "none", reason: `hung request in ${hung.sessionId} already cancelled` };
	}
	const label = modelLabel(input.model);
	const warn = `request timed out: no model reply for ${hung.idleMin} min (hung request${hung.firstCall ? ", first call" : ""}; cancelled)`;
	const patch: RecoveryFlowPatch = { hung: { dir: hung.sessionId, lastWrite: hung.lastWriteAt, at: iso(now) } };
	const hold = providerHold(input, warn);
	return {
		kind: "cancel_hung",
		// Stable across evaluations (the decision log keeps a record only when it changes): the last write, not the age.
		reason: `hung model request on ${label}: session ${hung.sessionId} running with nothing written since ${iso(hung.lastWriteAt)}`,
		input: cancel,
		patch,
		followUp: hold ?? {
			kind: "escalate",
			reason: `hung model requests on ${label}: retries used up and no outage probe for this provider`,
		},
	};
}

/**
 * A running session that has written no session file of its own for `stallNudgeMin` (the `no_session` stall): its
 * TUI never took the prompt, e.g. Cline's sign-in screen (issue #9, foo QA card ab61f 2026-10-08). It escalates at
 * once, without a nudge: the screen takes typed text as input and starts a Cline account sign-in, and a restart opens
 * the same screen until the user fixes Cline's settings.
 */
function decideNoSession(input: RecoveryCardInput): RecoveryDecision {
	const { session, settings, now } = input;
	const sentAt = input.flow.recoverySentAt ? Date.parse(input.flow.recoverySentAt) : Number.NaN;
	const stall = evaluateClineSilentStall({
		detail: input.detail,
		runStartedAt: session?.startedAt ?? null,
		kanbanProgressAt: Math.max(getSessionProgressAt(session) ?? 0, Number.isFinite(sentAt) ? sentAt : 0),
		now,
	});
	if (stall?.kind !== "no_session" || stall.idleMs < settings.stallNudgeMin * 60_000) {
		return { kind: "none", reason: "no Cline session file for this run yet" };
	}
	const what = describeClineSilentStall({ ...stall, signInGap: input.signInGap ?? null });
	return escalate(input, `${what} (${modelLabel(input.model)})`);
}

/**
 * A running session whose Cline file shows no progress for `stallNudgeMin` (evaluateClineSilentStall): a nudge, as
 * many as the nudge budget allows, then an escalation. A step cut off mid-call gets told so (foo 2026-10-07: four
 * cards sat 15 min on a tool_use with no result until a human typed "continue"). The clock restarts at every nudge
 * (`recoverySentAt`), so each further nudge needs another `stallNudgeMin` of silence. A shell tool whose command
 * still runs (`runningTool`: a long test run or build writes nothing to the session) is never stalled. A model
 * request in flight (`untouched` and the file still "running") is the hung-request check's when the agent can
 * cancel one: typing into a TUI that waits on the model doesn't help, and a slow first call may take `hungFirstMin`.
 */
function decideSilentStall(input: RecoveryCardInput, canCancel: boolean): RecoveryDecision {
	const { flow, settings, now } = input;
	const sentAt = flow.recoverySentAt ? Date.parse(flow.recoverySentAt) : Number.NaN;
	const stall = evaluateClineSilentStall({
		detail: input.detail,
		kanbanProgressAt: Math.max(getSessionProgressAt(input.session) ?? 0, Number.isFinite(sentAt) ? sentAt : 0),
		now,
	});
	if (!stall || stall.idleMs < settings.stallNudgeMin * 60_000) {
		return { kind: "none", reason: "no silent stall" };
	}
	if (stall.kind === "interrupted_tool" && input.runningTool) {
		return { kind: "none", reason: `the tool's command still runs (${input.runningTool})` };
	}
	if (stall.kind === "untouched" && stall.status === "running" && canCancel) {
		return { kind: "none", reason: "a model request in flight: the hung-request check owns it" };
	}
	if (flow.recoverySentAt && now - Date.parse(flow.recoverySentAt) < settings.nudgeCheckSec * 1000) {
		return { kind: "wait", reason: `waiting for the agent to pick up the message sent at ${flow.recoverySentAt}` };
	}
	return nudgeForSilentStall(input, stall);
}

function nudgeForSilentStall(input: RecoveryCardInput, stall: ClineSilentStall): RecoveryDecision {
	const { flow, settings, now } = input;
	const used = sinceBudget(flow.nudges, flow);
	const label = modelLabel(input.model);
	const what = describeClineSilentStall(stall);
	if (used.length >= settings.maxNudges) {
		return escalate(input, `agent keeps stalling silently (${used.length} nudges, ${label})`, [`last: ${what}`]);
	}
	return {
		kind: "nudge",
		cause: "silent_stall",
		// Stable across evaluations (the decision log keeps a record only when it changes): no age in it.
		reason: `silent stall: ${what}; nudge ${used.length + 1}/${settings.maxNudges} to ${label}`,
		clear: null,
		text: buildSilentStallPrompt(stall),
		overflow: null,
		patch: {
			nudges: [...flow.nudges, { at: iso(now), reason: "silent_stall", poisoned: false, warn: what.slice(0, 200) }],
		},
	};
}

/** What recovery should do about one card now. */
export function decideRecovery(input: RecoveryCardInput): RecoveryDecision {
	const { flow } = input;
	if (input.role !== "dev") {
		// QA cards get their own nudges from the QA gate (verdict outbox); calibration runs are calibrate's.
		return { kind: "none", reason: `role ${input.role}: not recovered as a dev card` };
	}
	if (flow.escalated) {
		return {
			kind: "none",
			reason: `escalated${flow.escalated.at ? ` at ${flow.escalated.at}` : ""}: ${flow.escalated.reason}`,
		};
	}
	if (flow.takeover) {
		const target = `${flow.takeover.to.agentId} on ${modelLabel(flow.takeover.to.model)}`;
		// Landing qa was switched off (or shadow on) since the request: nothing hands it over, so a human decides.
		return input.canTakeOver
			? { kind: "none", reason: `handing the task to ${target}: the rework loop's` }
			: escalate(
					input,
					`${flow.takeover.reason}; the kit hands it to ${target}, but the pipeline doesn't run here any more`,
					flow.takeover.details,
					{ takeover: null },
				);
	}
	if (flow.orphan) {
		return { kind: "none", reason: "orphaned by a Kanban restart: restart recovery resumes it" };
	}
	if (isReworkAwaitingStart(flow.openRework, input.now)) {
		return {
			kind: "none",
			reason: `rework sent at ${flow.openRework?.at}: the rework stage's started-check owns it until it starts`,
		};
	}
	return input.column === "review" ? decideReview(input) : decideInProgress(input);
}

/**
 * Why recovery holds a Review card back from the submission stage and the QA gate, or null. Ported from
 * archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (onDevReview: an orphan, a live session, a pending
 * provider-error retry or an outage hold is not finished work, so no snapshot and no QA round; dc6e70d, 692f174, 8a1bf34).
 */
export function recoveryHoldReason(entry: Record<string, unknown> | undefined): string | null {
	const flow = readRecoveryFlow(entry);
	if (flow.orphan) {
		return "orphaned by a Kanban restart";
	}
	if (flow.outage) {
		return `provider outage hold on ${flow.outage.model}`;
	}
	if (flow.takeover) {
		return `provider outage: handing the task to ${flow.takeover.to.agentId} on ${modelLabel(flow.takeover.to.model)}`;
	}
	if (flow.retryAt) {
		return `provider-error retry due at ${flow.retryAt}`;
	}
	return flow.liveHold ? `session ${flow.liveHold} is still running` : null;
}

/**
 * Why a Review card's turn is one recovery is redoing, or null: recovery typed into it (a nudge, a provider-error
 * retry, /clear + the card prompt; `recoverySentAt`) or resumed it after a restart less than `nudgeCheckMs` ago,
 * and the session has shown no activity since. That Review is the turn recovery just resent, so the submission stage
 * and the QA gate skip it (foo 27549, 2026-10-07: QA was queued on the snapshot of a turn recovery resent in the same
 * evaluation, then started on that snapshot once the redone turn ended). After `nudgeCheckMs` recovery decides on
 * the card again.
 */
export function recoveryRedoReason(
	entry: Record<string, unknown> | undefined,
	session: ReviewSettleSession | null,
	now: number,
	nudgeCheckMs: number,
): string | null {
	const sentAt = readRecoveryFlow(entry).recoverySentAt;
	const sent = sentAt ? Date.parse(sentAt) : Number.NaN;
	if (!Number.isFinite(sent) || now - sent >= nudgeCheckMs) {
		return null;
	}
	const activityAt = getReviewActivityAt(session);
	return activityAt !== null && activityAt > sent
		? null
		: `recovery resent the turn at ${sentAt}; waiting for the redone turn`;
}

/** State left behind when a card leaves In Progress / Review by hand: its retry, holds and orphan mark end. */
export function leftReviewPatch(flow: RecoveryFlowState, now: number): RecoveryFlowPatch {
	return {
		...(flow.retryAt ? { retryAt: null } : {}),
		...(flow.outage ? endOutagePatch(flow, now, "card moved by hand") : {}),
		...(flow.takeover ? { takeover: null } : {}),
		...(flow.liveHold ? { liveHold: null } : {}),
		// An orphan resumed (or finished, or trashed) by hand is not one any more.
		...(flow.orphan ? { orphan: null } : {}),
	};
}

/**
 * Whether a card's orphan mark is out of date: its session has a process again or was started by this server (a
 * resume, or the user restarting it by hand), or the mark is from an earlier server start. Only a card still
 * waiting for this start's resume keeps it.
 */
export function isOrphanMarkStale(
	flow: RecoveryFlowState,
	session: Pick<PipelineSessionView, "live" | "startedAt"> | null,
	serverStartedAt: number | undefined,
): boolean {
	if (!flow.orphan) {
		return false;
	}
	if (session?.live || (serverStartedAt !== undefined && (session?.startedAt ?? 0) >= serverStartedAt)) {
		return true;
	}
	return serverStartedAt !== undefined && Date.parse(flow.orphan.kanbanStart) !== serverStartedAt;
}
