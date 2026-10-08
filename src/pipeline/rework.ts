// The rework loop (plan §2.6, §4.0): what the core does after a dev card fails on a landing-`qa` workspace. The kit
// only answers `onFail` (rework, escalate, runoff or stop); the mechanics and the limits are here, the same for every
// kit:
//
// - triggers: the dev card's newest QA verdict is FAIL or STALLED (the QA gate's `qaVerdicts`), its PASS did not
//   land because of a merge conflict (the gate's `qaPass.landing`), or a rework came back with its snapshot
//   unchanged. Each trigger is acted on once (`qaflow.handled[]`, marked before acting, so a failure never loops).
// - the cap: at `pipeline.rework.maxFailRounds` FAIL rounds (land conflicts count, plus the extra rounds of each
//   `kanban task handback`) the core escalates whatever the kit says: to the kit's own target when the kit escalates
//   too (a tier or model), else to the orchestrator. The kit is asked first because its rounds usually equal the cap.
// - a card racing in an open runoff only escalates to the orchestrator (a sibling would race outside the group).
// - rework: the REWORK section goes into the card prompt before FINAL STEP, the QA notes into `.qa/r<N>/` in the
//   worktree; the section is typed into the card's own session (after the agent's clear command when the session is
//   past `clearAfterTurns`/`clearAfterTokens`, then with the whole prompt); a card with no session to type into gets
//   a fresh one from the card prompt, on the same agent and only when the card pins its model. The started-check
//   then looks for the rework running within two minutes, restarts it once, and escalates if it never ran.
//   `rework` is refused (→ escalate) when the card's session ran on another agent or model than the card names: a
//   restart would switch them.
// - escalate to the orchestrator: `qaflow.escalated`, `## ESCALATE` in the QA log, the card to Backlog as
//   `BLOCKED: …`; the watchdog lists it in ATTENTION.md and wakes the orchestrator. Escalate to a model: the work is
//   kept as `preserve/<id>-<model>`, a sibling card takes the task over on that model (started at once, or left in
//   Backlog for the orchestrator or the user when the kit says `requireApproval`), and the original is blocked.
// - runoff: sibling cards on the kit's models race the failed card, which is reworked as usual. The group is recorded
//   with the feature that holds every racing card's PASS (the team kit's `runoffs`, through
//   PipelineRunoffGroups) before any sibling is created, so neither the failed card nor a sibling can land before
//   the runoff is decided. Without such a feature for the workspace the answer is escalated to the orchestrator; a
//   card that already races gets a plain rework (runoffs never nest).
// - siblings (escalation and runoff) are never linked to the failed card on the board: a board link starts a Backlog
//   card when the other goes Review → Done (and flips direction when one leaves Backlog), so a link restarted a
//   BLOCKED original after its sibling landed (both land). The relation is the sibling's `sibling.of` entry, the
//   escalation record's `sibling` and the runoff group.
// - stop: the card stays in Review; `qaflow.stopped` puts one line in ATTENTION.md (watchdog) and wakes the
//   orchestrator.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (onVerdict, rework, checkReworkStarted,
// qaflowOnReview, escalate, blockCard, pendingHandback, failRoundsOf). Rules kept, each with a test in
// test/runtime/pipeline/rework.test.ts, rework-limits.test.ts or rework-text.test.ts:
// - mark the verdict handled before acting (a throw must not resend the same rework in a loop);
// - the REWORK section before FINAL STEP, so the next QA round sees it in the requirements;
// - same card, same agent, same model: a rework never switches model, and a restart only happens when the card pins
//   its model (a restart could otherwise fall back to the agent's default model);
// - QA notes staged in the worktree (b6bbe71), the stale-base line for a worktree behind its base (a3f076e);
// - the started-check skips a card escalated since the rework (a861b68) and one already back in Review (9052c06);
// - a rework that comes back with the same snapshot escalates instead of sitting in Review (no QA round would come);
// - a handback with extra rounds re-acts once on the FAIL that escalated the card (a1056e9, a1593 10/06).
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { PipelineConfig, WorkspacePipelineSettings } from "../config/pipeline-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeTaskAgentSettings,
	RuntimeTaskTrashResponse,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import type { EffectiveModel, EffectiveModelConfig } from "../core/effective-agent";
import { createUniqueTaskId } from "../core/task-id";
import type {
	CardHistory,
	EffectiveCard,
	EscalationTarget,
	FailCause,
	KitVerdict,
	OnFailAnswer,
	RoutingPolicy,
} from "../kits/policy";
import { getPipelineQaLogPath, getQaArtifactsPath } from "../state/kanban-home";
import type { ClineSessionSize } from "../terminal/cline-session-files";
import { isReviewSettled } from "../terminal/review-settle";
import type { PipelineActionRequest, PipelineActionResult, PipelineActions } from "./actions";
import type { PipelineDecisionOutcome, PipelineDecisionRecord } from "./decision-log";
import {
	isPipelineCandidate,
	type PipelineSessionView,
	type PipelineWorkspaceSnapshot,
	readCardHistory,
	toEffectiveCard,
} from "./engine";
import type { PipelineEventBus } from "./events";
import type { PipelineRunoffGroup, PipelineRunoffGroupHandler, PipelineRunoffGroups } from "./features";
import { readPipelineHold } from "./hold";
import type { PipelineCardState, PipelineStateStore } from "./pipeline-state";
import { readQaPassEntry, readQaVerdictRecords } from "./qa-gate";
import { type AppendQaLog, getQaLogSection, readQaLog } from "./qa-log";
import { recoveryHoldReason } from "./recovery";
import { findTaskWorktree, readStaleBase, type StageQaNotesInput, stageQaNotes } from "./rework-notes";
import { REWORK_STARTED_CHECK_MS } from "./rework-state";
import {
	buildClearedReworkMessage,
	buildPreserveTag,
	buildReworkText,
	buildRunoffSiblingPrompt,
	buildSiblingPrompt,
	insertBeforeFinalStep,
	modelSlug,
	type ReworkConflict,
	type StaleBase,
	stripBlockedPrefix,
} from "./rework-text";
import { readTaskSnapshot } from "./snapshots";
import type { PipelineFinishTaskRequest } from "./worker-protocol";

export { REWORK_STARTED_CHECK_MS } from "./rework-state";

const HANDLED_KEEP = 30;

export type ReworkVia = "pending" | "chat" | "chat (cleared)" | "task start" | "not started";

/** One sent rework (`qaflow.reworks[]`, the legacy shape plus what the started-check saw). */
export interface ReworkRecord {
	/** The QA round that failed, and the round the rework leads to. */
	round: number;
	next: number;
	at: string;
	/** The snapshot the failed round reviewed (an unchanged return has it again). */
	snapshot: string | null;
	kind: "fail" | "conflict" | "stalled" | "unchanged";
	via: ReworkVia;
	agentId: string;
	model: EffectiveModel | null;
	clearedContext: boolean;
	sawRunningAt?: string;
	leftReviewAt?: string;
	startedAt?: string;
	restartAt?: string;
	returned?: string;
	returnedSnapshot?: string | null;
	/**
	 * The rework is over without returning: a handback gave the card back (the escalation that followed it is
	 * settled), or a worker that died mid-send left it `pending` and it was sent again. The started-check ignores it.
	 */
	closedBy?: "handback" | "resent";
	closedAt?: string;
	/** What it was sent for, so a rework left `pending` by a worker crash can be sent again. */
	trigger?: ReworkTrigger;
	clearContext?: "auto" | "always" | "never";
}

export type EscalationCause = FailCause | "never_started" | "rework_impossible" | "rework_failed";

/** `qaflow.escalated`: the watchdog lists it in ATTENTION.md until a handback clears it. */
export interface EscalationRecord {
	at: string;
	round: number;
	reason: string;
	cause: EscalationCause;
	to: EscalationTarget;
	requireApproval: boolean;
	/** The card that took the task over, for an escalation to a model. */
	sibling?: { taskId: string; tag: string; started: boolean };
}

/** `qaflow.handbacks[]`, appended by `kanban task handback` (src/pipeline/handback.ts). */
export interface HandbackRecord {
	at: string;
	by: string;
	note: string;
	extraRounds: number;
	escalated: unknown;
}

/** `qaflow.stopped`: the kit answered `stop`; the card waits in Review for a human. */
export interface StopRecord {
	at: string;
	round: number;
	reason: string;
	cause: FailCause;
}

/** A sibling card's own entry (`cards[<sibling>].sibling`). */
export interface SiblingRecord {
	of: string;
	kind: "escalation" | "runoff";
	at: string;
	/** The runoff group, for kind `runoff`. */
	runoff?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readQaflow(entry: PipelineCardState | undefined): Record<string, unknown> {
	return isPlainObject(entry?.qaflow) ? entry.qaflow : {};
}

function readList<T>(value: unknown): T[] {
	return Array.isArray(value) ? value.filter((item): item is T => isPlainObject(item)) : [];
}

export function readReworks(qaflow: Record<string, unknown>): ReworkRecord[] {
	return readList<ReworkRecord>(qaflow.reworks);
}

export function readHandbacks(qaflow: Record<string, unknown>): HandbackRecord[] {
	return readList<HandbackRecord>(qaflow.handbacks);
}

export function readEscalationRecord(qaflow: Record<string, unknown>): EscalationRecord | null {
	return isPlainObject(qaflow.escalated) ? (qaflow.escalated as unknown as EscalationRecord) : null;
}

function readStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The newest handback, when it grants extra rounds, has not been acted on, and is newer than the trigger: the
 * pipeline then acts once more on the FAIL that escalated the card. Ported from
 * archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (pendingHandback).
 */
export function findPendingHandback(qaflow: Record<string, unknown>, triggerAt: number): HandbackRecord | null {
	const latest = readHandbacks(qaflow).at(-1);
	if (!latest || !(Number(latest.extraRounds) > 0) || readStrings(qaflow.handbackActed).includes(latest.at)) {
		return null;
	}
	return triggerAt < Date.parse(latest.at) ? latest : null;
}

export interface ReworkTrigger {
	cause: FailCause;
	/** `r<round>|<VERDICT>|<iso>`: the watchdog reads the time to tell a fresh verdict from a stalled card. */
	key: string;
	round: number;
	at: number;
	verdict: KitVerdict | null;
	snapshot: string | null;
	conflict: ReworkConflict | null;
	/** Where the QA gate kept the round's artifacts, when it recorded them. */
	artifactsDir?: string | null;
}

function verdictKey(round: number, verdict: string, at: number): string {
	return `r${round}|${verdict}|${new Date(at).toISOString()}`;
}

/**
 * Distinct FAIL rounds of the card: QA FAILs (only those after a fresh restart's `resetAt`) and land conflicts.
 * Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (failRoundsOf).
 */
export function countFailRounds(entry: PipelineCardState | undefined, extra: number[] = []): number[] {
	const qaflow = readQaflow(entry);
	const resetAt = typeof qaflow.resetAt === "string" ? Date.parse(qaflow.resetAt) : Number.NaN;
	const rounds = new Set<number>(extra);
	for (const verdict of readQaVerdictRecords(entry)) {
		if (verdict.verdict === "FAIL" && !(Number.isFinite(resetAt) && verdict.at < resetAt)) {
			rounds.add(verdict.round);
		}
	}
	for (const round of Array.isArray(qaflow.conflictRounds) ? qaflow.conflictRounds : []) {
		if (typeof round === "number") {
			rounds.add(round);
		}
	}
	return [...rounds].sort((left, right) => left - right);
}

export interface ReworkContext {
	snapshot: PipelineWorkspaceSnapshot;
	settings: WorkspacePipelineSettings;
	rework: PipelineConfig["pipeline"]["rework"];
	kitName: string;
	policy: RoutingPolicy;
	agentDefaultModels?: EffectiveModelConfig["agentDefaultModels"];
	/** `agents.cline.dataDir`, for reading a Cline session's size. */
	clineDataDir: string | null;
	now: number;
}

export interface ReworkDependencies {
	/** updateTask, resumeTask, blockTask, createTask, startTask on the server. */
	actions: PipelineActions;
	/** Types into a card's agent (the watchdog's `deliverInput` request, with its delivery check). */
	deliverInput: (input: {
		workspaceId: string;
		taskId: string;
		text: string;
	}) => Promise<{ ok: boolean; error?: string }>;
	store: PipelineStateStore;
	bus: PipelineEventBus;
	appendQaLog: AppendQaLog;
	/** The Done workflow (`trigger: "pipeline"`): a runoff sibling that could not start is discarded. */
	finishTask?: (request: PipelineFinishTaskRequest) => Promise<RuntimeTaskTrashResponse>;
	/** Where a runoff answer records its group (the worker's feature registry). Absent: runoffs are escalated. */
	runoffGroups?: PipelineRunoffGroups;
	/** Tags a card's current work (preserveTaskWork in hold.ts). */
	preserveWork: (input: { workspacePath: string; taskId: string; tag: string }) => Promise<unknown>;
	readSnapshot?: (repoPath: string, taskId: string) => Promise<string | null>;
	findWorktree?: (workspacePath: string, taskId: string) => Promise<string | null>;
	stageQaNotes?: (input: StageQaNotesInput) => Promise<string>;
	readStaleBase?: (input: {
		workspacePath: string;
		worktreePath: string;
		baseRef: string;
	}) => Promise<StaleBase | null>;
	/** The size of the card's session (orchestrator-agents.ts readAgentSessionSize). Default: unknown. */
	readSessionSize?: (
		agentId: RuntimeAgentId,
		worktreePath: string,
		options: { clineDataDir: string | null },
	) => Promise<ClineSessionSize | null>;
	/** The agent's clear command (orchestrator-agents.ts getAgentClearCommand). Default: none. */
	getClearCommand?: (agentId: RuntimeAgentId) => string | null;
	getQaLogPath?: (workspaceId: string) => string;
	getArtifactsPath?: (workspaceId: string) => string;
	randomUuid?: () => string;
	log: (message: string) => void;
}

export interface ReworkStage {
	/** Acts on new FAILs, conflicts and returned reworks, and checks sent reworks (never called in shadow). */
	tick: (context: ReworkContext) => Promise<PipelineDecisionRecord[]>;
}

type BoardEntry = { columnId: RuntimeBoardColumnId; card: RuntimeBoardCard };

function describeModel(model: EffectiveModel | null): string {
	return model ? `${model.provider ? `${model.provider}/` : ""}${model.model}` : "its default model";
}

function describeTarget(to: EscalationTarget): string {
	return to === "orchestrator" ? "the orchestrator" : `${to.agentId} on ${describeModel(to.model)}`;
}

function toAgentSettings(model: EffectiveModel): RuntimeTaskAgentSettings {
	return { ...(model.provider ? { providerId: model.provider } : {}), modelId: model.model };
}

/** Why a rework on the card's own session or settings would switch agent or model, or null when it wouldn't. */
export function findModelSwitch(card: RuntimeBoardCard, session: PipelineSessionView | null): string | null {
	if (session?.agentId && card.agentId && session.agentId !== card.agentId) {
		return `the work was done by ${session.agentId} but the card is set to ${card.agentId}`;
	}
	const cardModel = card.agentSettings?.modelId?.trim();
	const sessionModel = session?.modelId?.trim();
	if (cardModel && sessionModel && cardModel !== sessionModel) {
		return `the work was done on ${sessionModel} but the card is set to ${cardModel}`;
	}
	return null;
}

/**
 * A fresh session keeps the model only when the card pins it (or no model is known to keep); otherwise the agent
 * would start on its current default, which may not be the model that did the work.
 */
function canRestartOnSameModel(card: RuntimeBoardCard, session: PipelineSessionView | null): boolean {
	return Boolean(card.agentSettings?.modelId?.trim()) || !session?.modelId?.trim();
}

export function createReworkStage(deps: ReworkDependencies): ReworkStage {
	const readSnapshot = deps.readSnapshot ?? readTaskSnapshot;
	const findWorktree = deps.findWorktree ?? findTaskWorktree;
	const stageNotes = deps.stageQaNotes ?? stageQaNotes;
	const readStale = deps.readStaleBase ?? readStaleBase;
	const readSessionSize = deps.readSessionSize ?? (async () => null);
	const getClearCommand = deps.getClearCommand ?? (() => null);
	const qaLogPathOf = deps.getQaLogPath ?? ((workspaceId: string) => getPipelineQaLogPath(workspaceId));
	const artifactsPathOf = deps.getArtifactsPath ?? ((workspaceId: string) => getQaArtifactsPath(workspaceId));
	const randomUuid = deps.randomUuid ?? randomUUID;

	interface CardScope {
		context: ReworkContext;
		entry: BoardEntry;
		session: PipelineSessionView | null;
		dev: EffectiveCard;
		agentSource: PipelineDecisionRecord["effectiveAgent"];
		records: PipelineDecisionRecord[];
	}

	const record = (
		scope: CardScope,
		outcome: PipelineDecisionOutcome,
		note: string,
		answer: unknown = null,
		taskId = scope.entry.card.id,
	): void => {
		const { context } = scope;
		scope.records.push({
			at: new Date(context.now).toISOString(),
			workspaceId: context.snapshot.workspaceId,
			taskId,
			stage: "rework",
			kit: context.kitName,
			landingMode: context.settings.landing.mode,
			shadow: false,
			effectiveAgent: scope.agentSource,
			model: scope.dev.model,
			role: scope.dev.role,
			answer,
			outcome,
			note,
		});
	};

	const updateFlow = async (
		workspaceId: string,
		taskId: string,
		mutate: (qaflow: Record<string, unknown>) => Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const state = await deps.store.update(workspaceId, (current) => {
			const entry = current.cards[taskId] ?? {};
			current.cards[taskId] = { ...entry, qaflow: mutate({ ...readQaflow(entry) }) };
			return current;
		});
		return readQaflow(state.cards[taskId]);
	};

	const loadEntry = async (workspaceId: string, taskId: string): Promise<PipelineCardState | undefined> =>
		(await deps.store.load(workspaceId)).cards[taskId];

	const run = async (request: PipelineActionRequest): Promise<PipelineActionResult> =>
		await deps.actions.run(request).catch((error: unknown) => ({
			ok: false as const,
			error: error instanceof Error ? error.message : String(error),
		}));

	const scopeOf = (scope: CardScope) => ({
		workspaceId: scope.context.snapshot.workspaceId,
		workspacePath: scope.context.snapshot.workspacePath,
	});

	const deliver = async (scope: CardScope, text: string): Promise<{ ok: boolean; error?: string }> =>
		await deps
			.deliverInput({ workspaceId: scope.context.snapshot.workspaceId, taskId: scope.entry.card.id, text })
			.catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));

	/**
	 * The open runoff group a card races in. A group file that can't be read counts as racing ("unknown"): the caller
	 * then takes the safe path (no sibling outside the group).
	 */
	const findRunoffGroup = async (workspaceId: string, taskId: string): Promise<string | null> => {
		const groups = deps.runoffGroups?.forWorkspace(workspaceId);
		if (!groups) {
			return null;
		}
		try {
			return await groups.groupOf(taskId);
		} catch (error) {
			deps.log(`rework ${taskId}: the runoff groups can't be read: ${String(error)}`);
			return "(unreadable runoff groups)";
		}
	};

	const escalate = async (
		scope: CardScope,
		input: {
			round: number;
			reason: string;
			cause: EscalationCause;
			to?: EscalationTarget;
			requireApproval?: boolean;
			details?: string[];
			blocking?: string[];
			answer?: unknown;
		},
	): Promise<void> => {
		const { context } = scope;
		const { card } = scope.entry;
		const workspaceId = context.snapshot.workspaceId;
		const at = new Date(context.now).toISOString();
		let to: EscalationTarget = input.to ?? "orchestrator";
		let reason = input.reason;
		const requireApproval = input.requireApproval ?? false;
		let sibling: EscalationRecord["sibling"];
		if (to !== "orchestrator") {
			// A card racing in a runoff never hands its task to a sibling: the sibling would race outside the group and
			// could land next to the runoff's winner. The orchestrator decides instead.
			const racing = await findRunoffGroup(workspaceId, card.id);
			if (racing) {
				reason = `${reason}; it races in runoff ${racing}, so it goes to the orchestrator instead of ${describeTarget(to)}`;
				to = "orchestrator";
			}
		}
		if (to !== "orchestrator") {
			const target = to;
			const tag = buildPreserveTag(card.id, scope.dev.model?.model ?? target.model.model);
			const taken = await takeOver(scope, { target, tag, reason, blocking: input.blocking ?? [], requireApproval });
			if (taken.ok) {
				sibling = { taskId: taken.taskId, tag, started: taken.started };
			} else {
				to = "orchestrator";
				reason = `${reason}; handing it to ${describeTarget(target)} failed (${taken.error})`;
			}
		}
		const escalation: EscalationRecord = {
			at,
			round: input.round,
			reason,
			cause: input.cause,
			to,
			requireApproval,
			...(sibling ? { sibling } : {}),
		};
		await updateFlow(workspaceId, card.id, (qaflow) => ({ ...qaflow, escalated: escalation }));
		const siblingLine = sibling
			? `- Taken over by sibling card ${sibling.taskId} on ${describeTarget(to)}${sibling.started ? " (started)" : " (waits in Backlog for the orchestrator's or the user's approval)"}; this card's work is kept at tag ${sibling.tag}.`
			: null;
		await deps.appendQaLog(
			workspaceId,
			`\n${[
				`## ESCALATE ${card.id}: needs human (${reason})`,
				`- ${at} by Kanban. Card "${stripBlockedPrefix(card.title ?? "").slice(0, 80)}" (${scope.dev.agentId} on ${describeModel(scope.dev.model)}) goes to Backlog as BLOCKED; the pipeline stops acting on it.`,
				...(input.details ?? []).map((detail) => `- ${detail}`),
				...(siblingLine ? [siblingLine] : []),
				`- To hand it back to the pipeline: kanban task handback --task-id ${card.id} --note "<why>" [--extra-rounds N] (N more FAIL rounds; with N > 0 the pipeline reworks this FAIL).`,
			].join("\n")}\n`,
		);
		const blocked = await run({ ...scopeOf(scope), kind: "blockTask", taskId: card.id });
		if (!blocked.ok) {
			deps.log(`rework ${card.id}: moving the escalated card to Backlog failed: ${blocked.error}`);
		}
		record(
			scope,
			"acted",
			`escalated to ${describeTarget(to)} (${reason})${sibling ? `; sibling ${sibling.taskId}${sibling.started ? " started" : " waits for approval"}` : ""}${blocked.ok ? "; card → Backlog as BLOCKED" : `; moving it to Backlog failed (${blocked.error})`}`,
			input.answer ?? null,
		);
		await deps.bus.emit("escalated", {
			workspaceId,
			taskId: card.id,
			at: context.now,
			to,
			requireApproval,
			reason,
			round: input.round,
		});
	};

	/** A sibling card on another model takes the task over; the original's work is kept as `tag` first. */
	const takeOver = async (
		scope: CardScope,
		input: {
			target: Exclude<EscalationTarget, "orchestrator">;
			tag: string;
			reason: string;
			blocking: string[];
			requireApproval: boolean;
		},
	): Promise<{ ok: true; taskId: string; started: boolean } | { ok: false; error: string }> => {
		const { context } = scope;
		const { card } = scope.entry;
		try {
			await deps.preserveWork({ workspacePath: context.snapshot.workspacePath, taskId: card.id, tag: input.tag });
		} catch (error) {
			return { ok: false, error: `could not keep its work as ${input.tag}: ${String(error)}` };
		}
		const created = await createSibling(scope, {
			agentId: input.target.agentId,
			model: input.target.model,
			prompt: buildSiblingPrompt({
				prompt: scope.entry.card.prompt,
				fromTaskId: card.id,
				from: { agentId: scope.dev.agentId, model: scope.dev.model },
				reason: input.reason,
				tag: input.tag,
				blocking: input.blocking,
				now: context.now,
			}),
			title: `${stripBlockedPrefix(card.title ?? "")} [${modelSlug(input.target.model.model)}]`,
			sibling: { of: card.id, kind: "escalation", at: new Date(context.now).toISOString() },
			start: !input.requireApproval,
		});
		return created.ok ? { ok: true, taskId: created.taskId, started: created.started } : created;
	};

	/** Card ids on the board or in the pipeline state, so a new card's id is unique in both. */
	const loadKnownTaskIds = async (scope: CardScope): Promise<Set<string>> => {
		const { context } = scope;
		const known = new Set(context.snapshot.board.columns.flatMap((column) => column.cards.map((other) => other.id)));
		for (const id of Object.keys((await deps.store.load(context.snapshot.workspaceId)).cards)) {
			known.add(id);
		}
		return known;
	};

	/** A dev card on another model for the failed card's task, in Backlog (then started if `start`). */
	const createSibling = async (
		scope: CardScope,
		input: {
			/** Chosen beforehand (a runoff records its group first); default a fresh one. */
			taskId?: string;
			agentId: RuntimeAgentId;
			model: EffectiveModel;
			title: string;
			prompt: string;
			sibling: SiblingRecord;
			start: boolean;
		},
	): Promise<{ ok: true; taskId: string; started: boolean } | { ok: false; error: string }> => {
		const { context } = scope;
		const { card } = scope.entry;
		const workspaceId = context.snapshot.workspaceId;
		const taskId = input.taskId ?? createUniqueTaskId(await loadKnownTaskIds(scope), randomUuid);
		const created = await run({
			...scopeOf(scope),
			kind: "createTask",
			task: {
				taskId,
				title: input.title.slice(0, 200),
				prompt: input.prompt,
				role: "dev",
				agentId: input.agentId,
				agentSettings: toAgentSettings(input.model),
				baseRef: card.baseRef,
				// The sibling does the same issue's work: its land must still close the issue and comment on it.
				...(card.issue ? { issue: card.issue } : {}),
			},
		});
		if (!created.ok) {
			return { ok: false, error: `creating the sibling card failed: ${created.error}` };
		}
		const sibling = input.sibling;
		await deps.store.update(workspaceId, (state) => {
			state.cards[taskId] = { ...(state.cards[taskId] ?? {}), sibling };
			return state;
		});
		if (!input.start) {
			return { ok: true, taskId, started: false };
		}
		const started = await run({ ...scopeOf(scope), kind: "startTask", taskId });
		if (!started.ok) {
			deps.log(`rework ${card.id}: starting sibling card ${taskId} failed: ${started.error}`);
		}
		return { ok: true, taskId, started: started.ok };
	};

	const sendRework = async (
		scope: CardScope,
		trigger: ReworkTrigger,
		clearContext: "auto" | "always" | "never",
		answer: unknown,
	): Promise<void> => {
		const { context, session } = scope;
		const { card } = scope.entry;
		const workspaceId = context.snapshot.workspaceId;
		const workspacePath = context.snapshot.workspacePath;
		const modelSwitch = findModelSwitch(card, session);
		if (modelSwitch) {
			await escalate(scope, {
				round: trigger.round,
				reason: `rework impossible without switching model: ${modelSwitch}`,
				cause: "rework_impossible",
				blocking: trigger.verdict?.blocking,
				answer,
			});
			return;
		}
		const entry = await loadEntry(workspaceId, card.id);
		const { history } = readCardHistory(entry);
		const maxFailRounds = context.rework.maxFailRounds + history.extraRounds;
		// A rework sent again after a worker crash is the same rework, not another one.
		const reworkNumber = readReworks(readQaflow(entry)).filter((rework) => rework.closedBy !== "resent").length + 1;
		const worktreePath = await findWorktree(workspacePath, card.id);
		const qaLog = await readQaLog(qaLogPathOf(workspaceId));
		const qaSection = getQaLogSection(qaLog, card.id, trigger.round);
		const artifactsDir = trigger.artifactsDir ?? join(artifactsPathOf(workspaceId), card.id, `r${trigger.round}`);
		let stagedNotes: string | null = null;
		let staleBase: StaleBase | null = null;
		if (worktreePath) {
			if (!trigger.conflict) {
				stagedNotes = await stageNotes({ worktreePath, round: trigger.round, artifactsDir, qaSection }).catch(
					(error: unknown) => {
						deps.log(
							`rework ${card.id}: copying the QA notes into the worktree failed (${String(error)}); pointing at the QA log instead`,
						);
						return null;
					},
				);
			}
			staleBase = await readStale({ workspacePath, worktreePath, baseRef: card.baseRef }).catch(() => null);
		}
		const text = buildReworkText({
			taskId: card.id,
			round: trigger.round,
			verdict: trigger.verdict?.verdict ?? (trigger.cause === "unchanged" ? "rework came back unchanged" : "FAIL"),
			blocking: trigger.verdict?.blocking ?? [],
			qaSection,
			conflict: trigger.conflict,
			reworkNumber,
			maxFailRounds,
			baseRef: card.baseRef,
			repoPath: workspacePath,
			staleBase,
			stagedNotes,
			qaLogPath: qaLogPathOf(workspaceId),
			artifactsDir,
			now: context.now,
		});
		// Sent again after a crash that came after the prompt update: the card already has this section.
		const promptHasSection = card.prompt.includes(`REWORK round ${trigger.round + 1} (QA round ${trigger.round}:`);
		const prompt = promptHasSection ? card.prompt : insertBeforeFinalStep(card.prompt, text);
		const at = new Date(context.now).toISOString();
		const rework: ReworkRecord = {
			round: trigger.round,
			next: trigger.round + 1,
			at,
			snapshot: trigger.snapshot,
			kind: trigger.cause,
			via: "pending",
			agentId: scope.dev.agentId,
			model: scope.dev.model,
			clearedContext: false,
			trigger,
			clearContext,
		};
		// Recorded before anything is sent: a failure below must not send the same rework again.
		await updateFlow(workspaceId, card.id, (current) => ({
			...current,
			reworks: [...readReworks(current), rework],
			lastReworkAt: at,
		}));
		const updated = promptHasSection
			? ({ ok: true } as const)
			: await run({ ...scopeOf(scope), kind: "updateTask", taskId: card.id, prompt });
		if (!updated.ok) {
			await escalate(scope, {
				round: trigger.round,
				reason: `rework failed: updating the card prompt: ${updated.error}`,
				cause: "rework_failed",
				answer,
			});
			return;
		}
		const clearCommand = getClearCommand(scope.dev.agentId);
		let clear = false;
		if (clearCommand && clearContext !== "never") {
			if (clearContext === "always") {
				clear = true;
			} else if (worktreePath) {
				const size = await readSessionSize(scope.dev.agentId, worktreePath, { clineDataDir: context.clineDataDir });
				clear = Boolean(
					size &&
						(size.turns > context.rework.clearAfterTurns ||
							size.lastInputTokens > context.rework.clearAfterTokens),
				);
			}
		}
		let via: ReworkVia = "chat";
		let message = text;
		if (clear && clearCommand) {
			const cleared = await deliver(scope, clearCommand);
			if (cleared.ok) {
				via = "chat (cleared)";
				message = buildClearedReworkMessage(prompt);
			} else {
				deps.log(`rework ${card.id}: ${clearCommand} not delivered (${cleared.error}); resuming the full session`);
			}
		}
		const sent = await deliver(scope, message);
		let note: string;
		if (sent.ok) {
			note = via === "chat" ? "typed into its own session" : `its conversation was cleared first (${clearCommand})`;
		} else if (!canRestartOnSameModel(card, session)) {
			await updateFlow(workspaceId, card.id, (current) => setLastRework(current, { via: "not started" }));
			await escalate(scope, {
				round: trigger.round,
				reason: `rework impossible: no session to continue (${sent.error ?? "not delivered"}) and the card does not pin its model, so a new session could start on another one`,
				cause: "rework_impossible",
				blocking: trigger.verdict?.blocking,
				answer,
			});
			return;
		} else {
			// No prompt: the server reads the card's current one, which now has the REWORK section.
			const restarted = await run({
				...scopeOf(scope),
				kind: "resumeTask",
				taskId: card.id,
				agentId: scope.dev.agentId,
			});
			via = restarted.ok ? "task start" : "not started";
			note = restarted.ok
				? `no session to type into (${sent.error ?? "not delivered"}); started a new one from the card prompt`
				: `no session to type into (${sent.error ?? "not delivered"}) and starting a new one failed (${restarted.error}); the started-check retries`;
		}
		const clearedContext = via === "chat (cleared)";
		await updateFlow(workspaceId, card.id, (current) => setLastRework(current, { via, clearedContext }));
		const failRounds = countFailRounds(await loadEntry(workspaceId, card.id));
		await deps.appendQaLog(
			workspaceId,
			`\n${[
				`## Kanban REWORK ${card.id} round ${rework.next}: back to ${scope.dev.agentId} on ${describeModel(scope.dev.model)} (${at})`,
				`- QA round ${trigger.round}: ${trigger.conflict ? `PASS, but rebase onto ${trigger.conflict.baseRef}: conflicts in ${trigger.conflict.files.join(", ")}` : `${trigger.verdict?.verdict ?? trigger.cause}; blocking: ${(trigger.verdict?.blocking ?? []).join(" | ").slice(0, 600) || "see the QA section"}`}.`,
				`- Same card, same agent and model; ${note}. REWORK section added to the card prompt. FAIL rounds so far: ${failRounds.join(", ") || "none"} (escalates at ${maxFailRounds}).`,
			].join("\n")}\n`,
		);
		record(scope, "acted", `REWORK round ${rework.next} (${reworkNumber}/${maxFailRounds - 1}): ${note}`, answer);
		if (via !== "not started") {
			await deps.bus.emit("reworkSent", {
				workspaceId,
				taskId: card.id,
				at: context.now,
				round: rework.next,
				clearedContext,
			});
		}
	};

	/**
	 * The kit's runoff answer. Racing siblings need a feature that holds every racing card's PASS until the runoff is
	 * decided (without it a sibling and the failed card could both land), so with none the answer is escalated. A
	 * card that already races is reworked instead: runoffs never nest.
	 */
	const actOnRunoff = async (
		scope: CardScope,
		trigger: ReworkTrigger,
		answer: Extract<OnFailAnswer, { action: "runoff" }>,
	): Promise<void> => {
		const workspaceId = scope.context.snapshot.workspaceId;
		const models = answer.models.map((model) => model.model).join(", ");
		const refuse = async (why: string): Promise<void> =>
			await escalate(scope, {
				round: trigger.round,
				reason: `the kit answered runoff (${models}), but ${why}`,
				cause: trigger.cause,
				blocking: trigger.verdict?.blocking,
				answer,
			});
		const groups = deps.runoffGroups?.forWorkspace(workspaceId) ?? null;
		if (!groups) {
			await refuse(`the workspace's kit doesn't run the "runoffs" feature, which holds the racing cards' PASSes`);
			return;
		}
		let racing: string | null;
		try {
			racing = await groups.groupOf(scope.entry.card.id);
		} catch (error) {
			await refuse(`the runoff groups can't be read (${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		if (racing) {
			record(scope, "acted", `already races in runoff ${racing}; a runoff answer is a rework`, answer);
			await sendRework(scope, trigger, "auto", answer);
			return;
		}
		await startRunoff(scope, trigger, answer, groups);
	};

	/** A runoff sibling that never started leaves through the Done workflow (no worktree, nothing to land). */
	const discardUnstartedSibling = async (scope: CardScope, taskId: string): Promise<boolean> => {
		if (!deps.finishTask) {
			return false;
		}
		const result = await deps
			.finishTask({
				workspaceId: scope.context.snapshot.workspaceId,
				taskId,
				landing: "discard",
				trigger: "pipeline",
			})
			.catch(() => null);
		return result?.ok === true;
	};

	const parkUnstartedSibling = async (scope: CardScope, taskId: string, runoff: string): Promise<void> => {
		const workspaceId = scope.context.snapshot.workspaceId;
		const escalation: EscalationRecord = {
			at: new Date(scope.context.now).toISOString(),
			round: 0,
			reason: `runoff ${runoff}: the sibling card could not start, nor be discarded`,
			cause: "never_started",
			to: "orchestrator",
			requireApproval: false,
		};
		await updateFlow(workspaceId, taskId, (qaflow) => ({ ...qaflow, escalated: escalation }));
		const blocked = await run({ ...scopeOf(scope), kind: "blockTask", taskId });
		if (!blocked.ok) {
			deps.log(`rework: parking runoff sibling ${taskId} as BLOCKED failed: ${blocked.error}`);
		}
	};

	const startRunoff = async (
		scope: CardScope,
		trigger: ReworkTrigger,
		answer: Extract<OnFailAnswer, { action: "runoff" }>,
		groups: PipelineRunoffGroupHandler,
	): Promise<void> => {
		const { context } = scope;
		const { card } = scope.entry;
		const workspaceId = context.snapshot.workspaceId;
		const name = `${card.id}-r${trigger.round}`;
		const known = await loadKnownTaskIds(scope);
		const contenders = answer.models.map((model) => {
			const taskId = createUniqueTaskId(known, randomUuid);
			known.add(taskId);
			return {
				taskId,
				agentId: model.agentId,
				model: { provider: model.provider, model: model.model } satisfies EffectiveModel,
			};
		});
		const group: PipelineRunoffGroup = {
			name,
			from: card.id,
			round: trigger.round,
			baseRef: card.baseRef,
			cards: [{ taskId: card.id, agentId: scope.dev.agentId, model: scope.dev.model }, ...contenders],
		};
		// Recorded first: from here on every PASS of these cards is held until the runoff is decided.
		try {
			await groups.record(group);
		} catch (error) {
			await escalate(scope, {
				round: trigger.round,
				reason: `the kit answered runoff, but recording runoff ${name} failed (${error instanceof Error ? error.message : String(error)})`,
				cause: trigger.cause,
				blocking: trigger.verdict?.blocking,
				answer,
			});
			return;
		}
		const blocking = trigger.verdict?.blocking ?? [];
		const created: typeof contenders = [];
		const failures: string[] = [];
		for (const contender of contenders) {
			const sibling = await createSibling(scope, {
				taskId: contender.taskId,
				agentId: contender.agentId,
				model: contender.model,
				title: `${stripBlockedPrefix(card.title ?? "")} [runoff ${name}: ${modelSlug(contender.model.model)}]`,
				prompt: buildRunoffSiblingPrompt({
					prompt: card.prompt,
					fromTaskId: card.id,
					from: { agentId: scope.dev.agentId, model: scope.dev.model },
					runoff: name,
					round: trigger.round,
					blocking,
					now: context.now,
				}),
				sibling: { of: card.id, kind: "runoff", runoff: name, at: new Date(context.now).toISOString() },
				start: true,
			});
			if (!sibling.ok) {
				failures.push(`${contender.model.model}: ${sibling.error}`);
			} else if (sibling.started) {
				created.push(contender);
			} else if (await discardUnstartedSibling(scope, contender.taskId)) {
				failures.push(`${contender.model.model}: card ${contender.taskId} could not start and was discarded`);
			} else {
				// Still on the board and in the group, parked as escalated: the runoff counts it as finished, and the
				// pipeline never QAs or lands it if someone starts it by hand.
				created.push(contender);
				await parkUnstartedSibling(scope, contender.taskId, name);
				failures.push(`${contender.model.model}: card ${contender.taskId} could not start; parked as BLOCKED`);
			}
		}
		if (created.length < contenders.length) {
			await groups
				.record({
					...group,
					cards: [
						group.cards[0] ?? { taskId: card.id, agentId: scope.dev.agentId, model: scope.dev.model },
						...created,
					],
					...(created.length === 0
						? { abandoned: `no sibling card could be created (${failures.join("; ")})` }
						: {}),
				})
				.catch((error: unknown) => deps.log(`rework ${card.id}: updating runoff ${name} failed: ${String(error)}`));
		}
		if (created.length === 0) {
			await escalate(scope, {
				round: trigger.round,
				reason: `the kit answered runoff, but no sibling card could be created (${failures.join("; ")})`,
				cause: trigger.cause,
				blocking,
				answer,
			});
			return;
		}
		await deps.appendQaLog(
			workspaceId,
			`\n${[
				`## RUNOFF ${name} STARTED: ${card.id} (${scope.dev.agentId} on ${describeModel(scope.dev.model)}) races ${created.map((contender) => `${contender.taskId} (${contender.agentId} on ${describeModel(contender.model)})`).join(", ")}`,
				`- ${new Date(context.now).toISOString()} by Kanban: kit "${context.kitName}" answered runoff on the FAIL of round ${trigger.round}. ${card.id} is reworked as usual; every racing card's PASS is held, and the best one lands once all have passed or are escalated.`,
				...failures.map((failure) => `- Not created: ${failure}`),
			].join("\n")}\n`,
		);
		record(
			scope,
			"acted",
			`runoff ${name}: siblings ${created.map((contender) => contender.taskId).join(", ")}${failures.length > 0 ? ` (${failures.length} not created)` : ""}; the card is reworked too`,
			answer,
		);
		await sendRework(scope, trigger, "auto", answer);
	};

	/** Asks the kit (below the cap) and carries out the answer. */
	const actOnTrigger = async (scope: CardScope, trigger: ReworkTrigger): Promise<void> => {
		const { context } = scope;
		const { card } = scope.entry;
		const workspaceId = context.snapshot.workspaceId;
		const failRound = trigger.cause === "fail" || trigger.cause === "conflict";
		const qaflow = readQaflow(await loadEntry(workspaceId, card.id));
		const handback = failRound ? findPendingHandback(qaflow, trigger.at) : null;
		// Handled first: whatever happens below, this trigger is never acted on twice.
		await updateFlow(workspaceId, card.id, (current) => {
			const conflictRounds = Array.isArray(current.conflictRounds) ? current.conflictRounds : [];
			const next: Record<string, unknown> = {
				...current,
				handled: [...readStrings(current.handled), trigger.key].slice(-HANDLED_KEEP),
				lastRound: Math.max(typeof current.lastRound === "number" ? current.lastRound : 0, trigger.round),
				...(trigger.cause === "conflict" && !conflictRounds.includes(trigger.round)
					? { conflictRounds: [...conflictRounds, trigger.round] }
					: {}),
				...(handback ? { handbackActed: [...readStrings(current.handbackActed), handback.at] } : {}),
			};
			delete next.stopped;
			return next;
		});
		const failRounds = countFailRounds(await loadEntry(workspaceId, card.id));
		await updateFlow(workspaceId, card.id, (current) => ({ ...current, failRounds }));
		const { history } = readCardHistory(await loadEntry(workspaceId, card.id));
		const cap = context.rework.maxFailRounds + history.extraRounds;
		const handbackNote = handback ? `handback ${handback.at} (+${handback.extraRounds} rounds); ` : "";
		const answer = context.policy.onFail({
			dev: scope.dev,
			cause: trigger.cause,
			verdict: trigger.verdict,
			history: { ...history, failRounds } satisfies CardHistory,
			limits: { maxFailRounds: context.rework.maxFailRounds },
		});
		if (failRound && failRounds.length >= cap) {
			// The core's cap is a backstop: at it the card is escalated whatever the kit says, but to the kit's own
			// escalation target when the kit escalates too (team's `escalate.to: { tier }` opt-in, plan §12). Asking
			// first matters because the kit's rounds and the cap are usually equal (team: 3 and 3).
			const capReason = `${failRounds.length} FAIL rounds (rounds ${failRounds.join(", ")}${trigger.cause === "conflict" ? `; the last was a merge conflict with ${card.baseRef}` : ""})`;
			const kitEscalates = answer.action === "escalate" ? answer : null;
			await escalate(scope, {
				round: trigger.round,
				reason: capReason,
				cause: trigger.cause,
				...(kitEscalates ? { to: kitEscalates.to, requireApproval: kitEscalates.requireApproval } : {}),
				details: [
					trigger.conflict
						? `Conflicts in: ${trigger.conflict.files.join(", ")}`
						: `Last blocking: ${(trigger.verdict?.blocking ?? []).join(" | ").slice(0, 600) || "see the QA section"}`,
				],
				blocking: trigger.verdict?.blocking,
				answer: { core: "maxFailRounds", maxFailRounds: cap, kit: answer },
			});
			return;
		}
		if (handbackNote) {
			record(scope, "acted", `${handbackNote}acting again on ${trigger.key}`, null);
		}
		switch (answer.action) {
			case "rework":
				await sendRework(scope, trigger, answer.clearContext, answer);
				return;
			case "runoff":
				await actOnRunoff(scope, trigger, answer);
				return;
			case "escalate":
				await escalate(scope, {
					round: trigger.round,
					reason: answer.reason,
					cause: trigger.cause,
					to: answer.to,
					requireApproval: answer.requireApproval,
					details: trigger.verdict?.notes ? [`QA notes: ${trigger.verdict.notes.slice(0, 600)}`] : [],
					blocking: trigger.verdict?.blocking,
					answer,
				});
				return;
			case "stop": {
				const stopped: StopRecord = {
					at: new Date(context.now).toISOString(),
					round: trigger.round,
					reason: answer.reason,
					cause: trigger.cause,
				};
				await updateFlow(workspaceId, card.id, (current) => ({ ...current, stopped }));
				await deps.appendQaLog(
					workspaceId,
					`\n## STOPPED ${card.id}: ${answer.reason}\n- ${stopped.at} by Kanban (kit "${context.kitName}" answered stop on ${trigger.cause} in round ${trigger.round}). The card stays in Review for the orchestrator or the user.\n`,
				);
				record(scope, "acted", `stopped: ${answer.reason}; the card stays in Review`, answer);
				return;
			}
		}
	};

	/** The trigger for a Review card, or null (with a reason when it is worth a decision record). */
	const findTrigger = async (
		scope: CardScope,
		entry: PipelineCardState,
		since: number,
	): Promise<ReworkTrigger | null> => {
		const { context } = scope;
		const { card } = scope.entry;
		const qaflow = readQaflow(entry);
		const handled = new Set(readStrings(qaflow.handled));
		const lastRound = typeof qaflow.lastRound === "number" ? qaflow.lastRound : 0;
		const latest = readQaVerdictRecords(entry).at(-1);
		if (!latest || latest.at < since) {
			return null;
		}
		let trigger: ReworkTrigger | null = null;
		const verdict: KitVerdict = {
			verdict: latest.verdict === "PASS" ? "PASS" : latest.verdict === "FAIL" ? "FAIL" : "STALLED",
			round: latest.round,
			blocking: latest.blocking,
			notes: latest.notes,
		};
		if (latest.verdict === "FAIL" || latest.verdict === "STALLED") {
			trigger = {
				cause: latest.verdict === "FAIL" ? "fail" : "stalled",
				key: verdictKey(latest.round, latest.verdict, latest.at),
				round: latest.round,
				at: latest.at,
				verdict,
				snapshot: latest.snapshot,
				conflict: null,
				artifactsDir: latest.artifactsDir,
			};
		} else {
			const pass = readQaPassEntry(entry);
			if (pass?.action === "land" && pass.qaTaskId === latest.qaTaskId && pass.landing?.decision === "conflict") {
				trigger = {
					cause: "conflict",
					key: verdictKey(latest.round, "CONFLICT", pass.at),
					round: latest.round,
					at: pass.at,
					verdict,
					snapshot: pass.snapshot,
					conflict: { baseRef: pass.landing.baseRef ?? card.baseRef, files: pass.landing.files ?? [] },
				};
			}
		}
		if (!trigger) {
			return null;
		}
		const handback = trigger.cause === "stalled" ? null : findPendingHandback(qaflow, trigger.at);
		if (!handback && (handled.has(trigger.key) || trigger.round <= lastRound)) {
			return null;
		}
		if (trigger.cause !== "conflict") {
			const current = await readSnapshot(context.snapshot.workspacePath, card.id);
			if (current && current !== trigger.snapshot) {
				return null; // the card changed after QA: the new snapshot gets its own QA round
			}
		}
		return trigger;
	};

	/**
	 * A sent rework: notes what the board shows (left Review, ran), and once the card is back in Review whether
	 * anything changed. A rework that never shows up as started is restarted once, then escalated.
	 */
	const watchRework = async (scope: CardScope, entry: PipelineCardState): Promise<ReworkTrigger | null> => {
		const { context, session } = scope;
		const { card, columnId } = scope.entry;
		const workspaceId = context.snapshot.workspaceId;
		const qaflow = readQaflow(entry);
		const last = readReworks(qaflow).at(-1);
		if (!last || last.returned || last.closedBy) {
			return null;
		}
		const escalation = readEscalationRecord(qaflow);
		if (escalation && Date.parse(escalation.at) >= Date.parse(last.at)) {
			return null;
		}
		// A handback settles the escalation that followed this rework (never started, not started, impossible):
		// the started-check must not escalate it again.
		const handback = readHandbacks(qaflow).at(-1);
		if (handback && Date.parse(handback.at) >= Date.parse(last.at)) {
			return null;
		}
		const sentAt = Date.parse(last.at);
		const nowIso = new Date(context.now).toISOString();
		if (last.via === "pending") {
			await recoverPendingRework(scope, last, sentAt);
			return null;
		}
		const patch: Partial<ReworkRecord> = {};
		if (columnId === "in_progress" && !last.leftReviewAt) {
			patch.leftReviewAt = nowIso;
		}
		if (session?.state === "running" && !last.sawRunningAt) {
			patch.sawRunningAt = nowIso;
		}
		const sawIt = Boolean(last.leftReviewAt || last.sawRunningAt || patch.leftReviewAt || patch.sawRunningAt);
		// Recovery typed into the card since (a continue, a nudge): the session was there and took over the rework.
		const recoverySentAt = typeof qaflow.recoverySentAt === "string" ? Date.parse(qaflow.recoverySentAt) : 0;
		const hookSince =
			(session?.lastHookAt ?? 0) > sentAt || (session?.startedAt ?? 0) > sentAt || recoverySentAt > sentAt;
		let trigger: ReworkTrigger | null = null;
		// Back in Review only once the Review has settled: a turn that ends and resumes at once (Copilot autopilot)
		// would otherwise count as returned with half-done work, and as "unchanged" if it hadn't committed yet.
		if (columnId === "review" && isReviewSettled(session, context.now, context.snapshot.reviewSettleMs)) {
			const current = await readSnapshot(context.snapshot.workspacePath, card.id);
			const changed = Boolean(current && current !== last.snapshot);
			if (sawIt || changed || (hookSince && context.now - sentAt >= REWORK_STARTED_CHECK_MS)) {
				patch.returned = nowIso;
				patch.returnedSnapshot = current;
				if (current && !changed) {
					trigger = {
						cause: "unchanged",
						key: verdictKey(last.next, "UNCHANGED", context.now),
						round: last.round,
						at: context.now,
						verdict: null,
						snapshot: current,
						conflict: null,
					};
				} else {
					record(
						scope,
						"acted",
						`back in Review after rework round ${last.next} with snapshot ${current?.slice(0, 8) ?? "none"}; QA round ${last.next} is next`,
					);
				}
			}
		}
		const started = sawIt || hookSince || Boolean(patch.returned);
		if (started && !last.startedAt) {
			patch.startedAt = nowIso;
			const sessionModel = session?.modelId?.trim();
			if (sessionModel && last.model && sessionModel !== last.model.model) {
				await deps.appendQaLog(
					workspaceId,
					`\n## Kanban WARNING ${card.id}: the rework session runs ${sessionModel}, not the card's ${describeModel(last.model)}\n- Check the card; Kanban did not change its settings.\n`,
				);
				record(scope, "acted", `the rework session runs ${sessionModel}, not ${describeModel(last.model)}`);
			}
		}
		if (!started && context.now - sentAt >= REWORK_STARTED_CHECK_MS) {
			if (!last.restartAt) {
				patch.restartAt = nowIso;
				if (canRestartOnSameModel(card, session)) {
					// The live session (if any) never took the rework: replace it, or startTaskSession would hand it back.
					// Never `continueConversation`: a fresh session from the card prompt (REWORK section included) is
					// what delivers the rework; continuing would keep the conversation that never took it.
					const restarted = await run({
						...scopeOf(scope),
						kind: "resumeTask",
						taskId: card.id,
						agentId: scope.dev.agentId,
						replaceLive: true,
					});
					record(
						scope,
						"acted",
						`rework round ${last.next} not running after ${REWORK_STARTED_CHECK_MS / 1000} s; ${restarted.ok ? "started a new session from the card prompt" : `starting a new session failed (${restarted.error})`}`,
					);
				} else {
					record(
						scope,
						"acted",
						`rework round ${last.next} not running after ${REWORK_STARTED_CHECK_MS / 1000} s; the card does not pin its model, so it is not restarted`,
					);
				}
			} else if (context.now - Date.parse(last.restartAt) >= REWORK_STARTED_CHECK_MS) {
				await updateFlow(workspaceId, card.id, (current) => setLastRework(current, patch));
				await escalate(scope, {
					round: last.round,
					reason: `rework round ${last.next} never started`,
					cause: "never_started",
				});
				return null;
			}
		}
		if (Object.keys(patch).length > 0) {
			await updateFlow(workspaceId, card.id, (current) => setLastRework(current, patch));
		}
		return trigger;
	};

	/**
	 * A rework still `pending` after the started-check time: the worker died between recording and sending it. If the
	 * card ran meanwhile it was delivered; otherwise it is closed and sent again from its recorded trigger.
	 */
	const recoverPendingRework = async (scope: CardScope, last: ReworkRecord, sentAt: number): Promise<void> => {
		const { context, session } = scope;
		const { card, columnId } = scope.entry;
		const workspaceId = context.snapshot.workspaceId;
		if (context.now - sentAt < REWORK_STARTED_CHECK_MS) {
			return;
		}
		const ran =
			columnId === "in_progress" ||
			session?.state === "running" ||
			(session?.lastHookAt ?? 0) > sentAt ||
			(session?.startedAt ?? 0) > sentAt;
		if (ran) {
			await updateFlow(workspaceId, card.id, (current) => setLastRework(current, { via: "chat" }));
			record(scope, "acted", `rework round ${last.next} was left pending, but the card ran since; counted as sent`);
			return;
		}
		if (columnId !== "review" || !isReviewSettled(session, context.now, context.snapshot.reviewSettleMs)) {
			return;
		}
		const nowIso = new Date(context.now).toISOString();
		await updateFlow(workspaceId, card.id, (current) =>
			setLastRework(current, { closedBy: "resent", closedAt: nowIso }),
		);
		if (!last.trigger) {
			await escalate(scope, {
				round: last.round,
				reason: `rework round ${last.next} was left half-sent (the pipeline worker stopped) and can't be sent again`,
				cause: "rework_failed",
			});
			return;
		}
		record(scope, "acted", `rework round ${last.next} was left pending by a stopped worker; sending it again`);
		await sendRework(scope, last.trigger, last.clearContext ?? "auto", null);
	};

	const tick: ReworkStage["tick"] = async (context) => {
		const { snapshot } = context;
		const workspaceId = snapshot.workspaceId;
		const records: PipelineDecisionRecord[] = [];
		const sessions = new Map(snapshot.sessions.map((session) => [session.taskId, session]));
		const state = await deps.store.load(workspaceId);
		const since = Date.parse(state.since);
		for (const column of snapshot.board.columns) {
			if (column.id === "trash") {
				continue;
			}
			for (const card of column.cards) {
				if (!state.cards[card.id] || resolveCardRole(card) !== "dev" || !isPipelineCandidate(card)) {
					continue;
				}
				const session = sessions.get(card.id) ?? null;
				const { effective, agentSource } = toEffectiveCard({
					card,
					session,
					workspaceId,
					selectedAgentId: snapshot.selectedAgentId,
					agentDefaultModels: context.agentDefaultModels,
				});
				const scope: CardScope = {
					context,
					entry: { columnId: column.id, card },
					session,
					dev: effective,
					agentSource,
					records,
				};
				try {
					await tickCard(scope, since);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					deps.log(`rework ${card.id}: ${message}`);
					record(scope, "none", `the rework stage failed: ${message}`);
				}
			}
		}
		return records;
	};

	const tickCard = async (scope: CardScope, since: number): Promise<void> => {
		const workspaceId = scope.context.snapshot.workspaceId;
		const { card, columnId } = scope.entry;
		let entry = await loadEntry(workspaceId, card.id);
		if (!entry) {
			return;
		}
		// Recovery owns a card it holds (orphaned by a restart, an outage, a provider retry, a live session): no
		// started-check restart or escalation and no new rework until it lets go.
		if (recoveryHoldReason(entry)) {
			return;
		}
		if (columnId !== "review" && readQaflow(entry).stopped) {
			await updateFlow(workspaceId, card.id, (qaflow) => {
				const next = { ...qaflow };
				delete next.stopped;
				return next;
			});
		}
		const unchanged = await watchRework(scope, entry);
		const { context } = scope;
		if (columnId !== "review" || !isReviewSettled(scope.session, context.now, context.snapshot.reviewSettleMs)) {
			return;
		}
		entry = await loadEntry(workspaceId, card.id);
		const qaflow = readQaflow(entry);
		if (!entry || readPipelineHold(entry)) {
			return;
		}
		if (readEscalationRecord(qaflow)) {
			return;
		}
		const trigger = unchanged ?? (await findTrigger(scope, entry, since));
		if (trigger) {
			await actOnTrigger(scope, trigger);
		}
	};

	return { tick };
}

function setLastRework(qaflow: Record<string, unknown>, patch: Partial<ReworkRecord>): Record<string, unknown> {
	const reworks = readReworks(qaflow);
	const last = reworks.at(-1);
	if (!last) {
		return qaflow;
	}
	return { ...qaflow, reworks: [...reworks.slice(0, -1), { ...last, ...patch }] };
}
