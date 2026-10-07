// The cutover's shadow diff (plan §8.4 step 1, P4-8): what the pipeline decided on a shadow workspace next to what
// the legacy kit's autoland did on the same board. Pure: the caller loads the logs, the board and the resolved kit
// (load-shadow-diff-inputs.ts), and scripts/pipeline-shadow-diff.ts prints the report.
//
// What can be compared, and from where:
// - QA routing: the pipeline's `qa_gate` answers (decision log) vs the QA cards autoland created (its log, plus the
//   QA card's agent and model on the board) or the dev cards it refused to QA.
// - What happens after a FAIL, STALLED or land conflict: in shadow the pipeline creates no QA cards, so it never has
//   a verdict of its own to act on. The kit's `onFail` is therefore asked here, offline, with the legacy verdict and
//   the card's FAIL history from the legacy log (pipeline `rework` records are used instead when there are any).
// - Recovery: the pipeline's `recovery` decisions (mode `report` or shadow) vs autoland's nudges and holds.
// - Restart recovery: the orphans each side found for the same Kanban start.
// - Dev assignment: what the kit proposed for each new card (`dev-assignment.jsonl`) vs what its creator chose.
// Snapshots, checks and landing have nothing to compare in shadow (they are mechanics with no routing answer),
// so the report only counts them.
import {
	type RuntimeAgentId,
	type RuntimeBoardCard,
	type RuntimeBoardData,
	runtimeAgentIdSchema,
} from "../../core/api-contract";
import { resolveCardRole } from "../../core/card-role";
import type { EffectiveModel } from "../../core/effective-agent";
import type { DevAssignmentLogEntry } from "../../kits/dev-assignment";
import type { CardHistory, FailCause, OnFailAnswer, RoutingPolicy } from "../../kits/policy";
import type { PipelineDecisionRecord } from "../decision-log";
import type { LegacyAction, LegacyAutolandLog, LegacyCardEvent } from "./legacy-autoland-log";

export type ShadowDiffCategory = "qa_routing" | "on_fail" | "recovery" | "restart" | "dev_assignment";

/**
 * `same`: both sides decided the same. `different`: they didn't (unexplained until someone looks). `known`: a
 * difference the plan expects (`note` says which). `unverified`: one side's details are gone (e.g. the card was
 * pruned from the board), so only the fact that both acted is known. `legacy_only` / `pipeline_only`: only one side
 * decided anything for it inside the matching window.
 */
export type ShadowDiffStatus = "same" | "different" | "known" | "unverified" | "legacy_only" | "pipeline_only";

/** Statuses that keep the cutover's exit criterion ("no unexplained difference") from being met. */
export const UNEXPLAINED_STATUSES: readonly ShadowDiffStatus[] = ["different", "legacy_only", "pipeline_only"];

export interface ShadowDiffItem {
	category: ShadowDiffCategory;
	status: ShadowDiffStatus;
	taskId: string | null;
	at: string;
	legacy: string;
	pipeline: string;
	note: string | null;
}

export interface ShadowDiffInput {
	workspaceId: string;
	since: number;
	until: number;
	/** How far apart in time the two sides' decisions about the same thing may be. */
	windowMs: number;
	legacy: LegacyAutolandLog;
	decisions: readonly PipelineDecisionRecord[];
	devAssignments: readonly DevAssignmentLogEntry[];
	board: RuntimeBoardData | null;
	selectedAgentId: RuntimeAgentId;
	kitName: string;
	policy: RoutingPolicy;
	maxFailRounds: number;
	/** `qaflow.resetAt` per card from the legacy kit's checks-state.json (a restart-fresh's FAIL-count reset). */
	legacyResets: Record<string, string>;
}

export interface ShadowDiffReport {
	workspaceId: string;
	kitName: string;
	since: string;
	until: string;
	items: ShadowDiffItem[];
	/** Counts with nothing to compare in shadow: legacy actions and pipeline records by kind. */
	counts: { legacy: Record<string, number>; pipeline: Record<string, number> };
	unexplained: number;
}

/** How long after a verdict autoland's reaction (rework or escalation) still counts as the reaction to it. */
const REACTION_WINDOW_MS = 30 * 60_000;
/** Restart orphan records are written in the same evaluation as the restart's summary record. */
const RESTART_GROUP_MS = 60_000;
/**
 * How far apart the two sides' times for the same Kanban start may be. Autoland reads the server process's start
 * from /proc; the server records `Date.now() - process.uptime()` once it has bound its port (~0.5 s later on the pod).
 */
const RESTART_START_MATCH_MS = 10_000;

const time = (iso: string): number => Date.parse(iso);

function describeModel(model: EffectiveModel | null | undefined): string {
	if (!model) {
		return "its default model";
	}
	return model.provider ? `${model.provider}/${model.model}` : model.model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Consecutive pipeline records about one card with the same answer, as one decision held from `first` to `last`. */
interface Episode {
	taskId: string;
	signature: string;
	first: number;
	last: number;
	record: PipelineDecisionRecord;
	matched: boolean;
}

function collapseEpisodes(
	records: readonly PipelineDecisionRecord[],
	signatureOf: (record: PipelineDecisionRecord) => string | null,
): Episode[] {
	const open = new Map<string, Episode>();
	const episodes: Episode[] = [];
	for (const record of [...records].sort((a, b) => time(a.at) - time(b.at))) {
		const signature = record.taskId ? signatureOf(record) : null;
		if (!record.taskId || signature === null) {
			continue;
		}
		const at = time(record.at);
		const current = open.get(record.taskId);
		if (current && current.signature === signature) {
			current.last = at;
			continue;
		}
		const episode = { taskId: record.taskId, signature, first: at, last: at, record, matched: false };
		open.set(record.taskId, episode);
		episodes.push(episode);
	}
	return episodes;
}

/** The episode of `taskId` closest to `at`, among those within `windowMs` of it. */
function findEpisode(episodes: readonly Episode[], taskId: string, at: number, windowMs: number): Episode | null {
	let best: Episode | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const episode of episodes) {
		if (episode.taskId !== taskId) {
			continue;
		}
		const distance = at < episode.first ? episode.first - at : at > episode.last ? at - episode.last : 0;
		if (distance <= windowMs && distance < bestDistance) {
			best = episode;
			bestDistance = distance;
		}
	}
	return best;
}

function boardCards(board: RuntimeBoardData | null): Map<string, RuntimeBoardCard> {
	return new Map((board?.columns ?? []).flatMap((column) => column.cards.map((card) => [card.id, card] as const)));
}

function cardModel(card: RuntimeBoardCard | undefined): EffectiveModel | null {
	const model = card?.agentSettings?.modelId?.trim();
	return model ? { provider: card?.agentSettings?.providerId?.trim() || null, model } : null;
}

interface QaAnswerView {
	kind: "qa" | "none";
	agentId: string | null;
	model: EffectiveModel | null;
	route: string | null;
	reason: string | null;
}

function readQaAnswer(answer: unknown): QaAnswerView | null {
	if (!isRecord(answer) || (answer.kind !== "qa" && answer.kind !== "none")) {
		return null;
	}
	const model = isRecord(answer.model) && typeof answer.model.model === "string" ? answer.model : null;
	return {
		kind: answer.kind,
		agentId: typeof answer.agentId === "string" ? answer.agentId : null,
		model: model
			? { provider: typeof model.provider === "string" ? model.provider : null, model: String(model.model) }
			: null,
		route: typeof answer.route === "string" ? answer.route : null,
		reason: typeof answer.reason === "string" ? answer.reason : null,
	};
}

function describeQaAnswer(view: QaAnswerView): string {
	return view.kind === "none"
		? `no QA (${view.reason ?? "no reason"})`
		: `QA on ${view.agentId} with ${describeModel(view.model)} (${view.route ?? "qa.default"})`;
}

function compareQaRouting(
	input: ShadowDiffInput,
	events: readonly LegacyCardEvent[],
	cards: Map<string, RuntimeBoardCard>,
): ShadowDiffItem[] {
	const episodes = collapseEpisodes(
		input.decisions.filter((record) => record.stage === "qa_gate"),
		(record) => {
			const view = readQaAnswer(record.answer);
			return view ? JSON.stringify([view.kind, view.agentId, view.model, view.route]) : null;
		},
	);
	const items: ShadowDiffItem[] = [];
	const legacyQaTimes = new Map<string, number[]>();
	for (const event of events) {
		const { action } = event;
		if (action.kind !== "qa_created" && action.kind !== "qa_skipped" && action.kind !== "qa_existing") {
			continue;
		}
		const at = time(event.at);
		legacyQaTimes.set(event.taskId, [...(legacyQaTimes.get(event.taskId) ?? []), at]);
		if (action.kind === "qa_existing") {
			continue;
		}
		const episode = findEpisode(episodes, event.taskId, at, input.windowMs);
		if (episode) {
			episode.matched = true;
		}
		const view = episode ? readQaAnswer(episode.record.answer) : null;
		const base = { category: "qa_routing" as const, taskId: event.taskId, at: event.at };
		if (action.kind === "qa_skipped") {
			const legacy = `no QA: ${action.reason}`;
			if (!view) {
				items.push({ ...base, status: "legacy_only", legacy, pipeline: "no qaPolicy answer", note: null });
			} else if (view.kind === "none") {
				items.push({ ...base, status: "same", legacy, pipeline: describeQaAnswer(view), note: null });
			} else {
				// The legacy kit skipped Claude-built dev cards by agent id; the team kit QAs them (plan §12).
				const known = /\bclaude\b/u.test(action.reason);
				items.push({
					...base,
					status: known ? "known" : "different",
					legacy,
					pipeline: describeQaAnswer(view),
					note: known
						? "plan §12: Claude-built dev cards get QA on the team kit (set qa.skip.effectiveAgents to skip them)"
						: null,
				});
			}
			continue;
		}
		const qaCard = cards.get(action.qaTaskId);
		const legacyAgent = qaCard ? (qaCard.agentId ?? input.selectedAgentId) : null;
		const legacyModel = cardModel(qaCard);
		const legacy = qaCard
			? `QA card ${action.qaTaskId} on ${legacyAgent} with ${describeModel(legacyModel)}`
			: `QA card ${action.qaTaskId} (not on the board any more)`;
		if (!view) {
			items.push({ ...base, status: "legacy_only", legacy, pipeline: "no qaPolicy answer", note: null });
			continue;
		}
		if (view.kind === "none") {
			items.push({ ...base, status: "different", legacy, pipeline: describeQaAnswer(view), note: null });
			continue;
		}
		if (!qaCard) {
			items.push({
				...base,
				status: "unverified",
				legacy,
				pipeline: describeQaAnswer(view),
				note: "both QA the card; the legacy QA card's agent can't be read",
			});
			continue;
		}
		// No model in the answer = the QA agent's own default (Codex's config.toml), which a card doesn't record.
		const sameModel = view.model === null || legacyModel?.model === view.model.model;
		const same = legacyAgent === view.agentId && sameModel;
		items.push({
			...base,
			status: same ? "same" : "different",
			legacy,
			pipeline: describeQaAnswer(view),
			note: same && view.model === null && legacyModel ? "the kit names no model: the agent's default" : null,
		});
	}
	for (const episode of episodes) {
		const view = readQaAnswer(episode.record.answer);
		if (episode.matched || view?.kind !== "qa") {
			continue;
		}
		const legacyNear = (legacyQaTimes.get(episode.taskId) ?? []).some(
			(at) => at >= episode.first - input.windowMs && at <= episode.last + input.windowMs,
		);
		if (!legacyNear) {
			items.push({
				category: "qa_routing",
				status: "pipeline_only",
				taskId: episode.taskId,
				at: episode.record.at,
				legacy: "no QA decision",
				pipeline: describeQaAnswer(view),
				note: null,
			});
		}
	}
	return items;
}

type OnFailKind = OnFailAnswer["action"] | "none";

function describeOnFail(answer: OnFailAnswer): string {
	switch (answer.action) {
		case "rework":
			return "rework on the same card and model";
		case "escalate":
			return `escalate to ${answer.to === "orchestrator" ? "the orchestrator" : `${answer.to.agentId} ${describeModel(answer.to.model)}`}${answer.requireApproval ? " (needs approval)" : ""}: ${answer.reason}`;
		case "runoff":
			return `runoff on ${answer.models.map((model) => model.model).join(", ")}`;
		case "stop":
			return `stop: ${answer.reason}`;
	}
}

function readOnFailAction(answer: unknown): OnFailKind | null {
	if (!isRecord(answer)) {
		return null;
	}
	const action = answer.action;
	return action === "rework" || action === "escalate" || action === "runoff" || action === "stop" ? action : null;
}

function legacyReaction(events: readonly LegacyCardEvent[], index: number): LegacyCardEvent | null {
	const trigger = events[index] as LegacyCardEvent;
	const start = time(trigger.at);
	for (const event of events.slice(index + 1)) {
		if (event.taskId !== trigger.taskId) {
			continue;
		}
		if (time(event.at) - start > REACTION_WINDOW_MS || event.action.kind === "verdict") {
			return null;
		}
		if (event.action.kind === "rework" || event.action.kind === "escalated") {
			return event;
		}
	}
	return null;
}

function compareOnFail(
	input: ShadowDiffInput,
	events: readonly LegacyCardEvent[],
	allCardEvents: readonly LegacyCardEvent[],
	cards: Map<string, RuntimeBoardCard>,
): ShadowDiffItem[] {
	const reworkRecords = input.decisions.filter(
		(record) => record.stage === "rework" && readOnFailAction(record.answer) !== null,
	);
	const items: ShadowDiffItem[] = [];
	events.forEach((event, index) => {
		const { action } = event;
		const cause: FailCause | null =
			action.kind === "conflict"
				? "conflict"
				: action.kind === "verdict" && action.verdict === "FAIL"
					? "fail"
					: action.kind === "verdict" && action.verdict === "STALLED"
						? "stalled"
						: null;
		if (!cause) {
			return;
		}
		const at = time(event.at);
		const reaction = legacyReaction(events, index);
		const legacyKind: OnFailKind =
			reaction?.action.kind === "rework" ? "rework" : reaction?.action.kind === "escalated" ? "escalate" : "none";
		const legacy = reaction
			? reaction.action.kind === "rework"
				? `rework round ${reaction.action.round} on ${reaction.action.agent} ${reaction.action.model ?? ""}`.trim()
				: `escalated (${(reaction.action as Extract<LegacyAction, { kind: "escalated" }>).reason})`
			: "no rework or escalation";
		const base = { category: "on_fail" as const, taskId: event.taskId, at: event.at };
		const logged = reworkRecords.find(
			(record) =>
				record.taskId === event.taskId &&
				time(record.at) >= at - input.windowMs &&
				time(record.at) <= at + REACTION_WINDOW_MS,
		);
		let pipelineKind: OnFailKind;
		let pipeline: string;
		if (logged) {
			pipelineKind = readOnFailAction(logged.answer) ?? "none";
			pipeline = `${logged.note} (pipeline log)`;
		} else {
			const reworked = reaction?.action.kind === "rework" ? reaction.action : null;
			const card = cards.get(event.taskId) ?? (reworked ? prunedCard(event.taskId, reworked.agent) : null);
			if (!card) {
				items.push({
					...base,
					status: "unverified",
					legacy,
					pipeline: "not evaluated",
					note: "the card is not on the board any more",
				});
				return;
			}
			const history = failHistory(allCardEvents, event.taskId, reaction ? time(reaction.at) : at, {
				at,
				resetAt: input.legacyResets[event.taskId] ?? null,
			});
			const answer = input.policy.onFail({
				dev: {
					card,
					workspaceId: input.workspaceId,
					role: resolveCardRole(card),
					agentId: card.agentId ?? input.selectedAgentId,
					model: reworked?.model ? { provider: null, model: reworked.model } : cardModel(card),
				},
				cause,
				verdict: action.kind === "verdict" ? { verdict: action.verdict, round: action.round } : null,
				history,
				limits: { maxFailRounds: input.maxFailRounds },
			});
			pipelineKind = answer.action;
			pipeline = `${describeOnFail(answer)} (kit "${input.kitName}" asked, FAIL rounds ${history.failRounds.length})`;
		}
		const same =
			pipelineKind === legacyKind ||
			// The kit's "stop" leaves the card waiting, as autoland does when it neither reworks nor escalates.
			(pipelineKind === "stop" && legacyKind === "none");
		// Since K-1 autoland reworks only Cline cards; the pipeline types the rework into any agent's session.
		const knownAgentLimit =
			!same &&
			pipelineKind === "rework" &&
			reaction?.action.kind === "escalated" &&
			/rework impossible/u.test(reaction.action.reason);
		items.push({
			...base,
			status: same ? "same" : knownAgentLimit ? "known" : "different",
			legacy: `${cause}: ${legacy}`,
			pipeline,
			note: knownAgentLimit
				? "the legacy kit reworks only Cline cards; the pipeline reworks any agent's card"
				: null,
		});
	});
	return items;
}

/**
 * A dev card pruned from the board since, rebuilt from autoland's REWORK line (it names the agent and model, and
 * autoland reworks only dev cards). Null when the line's agent isn't a Kanban agent id.
 */
function prunedCard(taskId: string, agent: string): RuntimeBoardCard | null {
	const agentId = runtimeAgentIdSchema.safeParse(agent);
	if (!agentId.success) {
		return null;
	}
	return {
		id: taskId,
		title: taskId,
		prompt: "",
		startInPlanMode: false,
		role: "dev",
		agentId: agentId.data,
		baseRef: "",
		createdAt: 0,
		updatedAt: 0,
	};
}

/**
 * A card's FAIL rounds (verdicts and land conflicts) up to the verdict at `verdict.at`, and the extra rounds the
 * handbacks granted up to `until` (autoland logs a handback just after the verdict it re-acts on).
 *
 * Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (failRounds: lines older than
 * `qaflow.resetAt` don't count) and tools/restart-fresh.mjs (which sets `resetAt` when it moves a card to another
 * model). The log has no line for a restart-fresh, so a REWORK on another model than the card's previous REWORK
 * counts as one too: only the FAIL it answers is kept.
 */
function failHistory(
	events: readonly LegacyCardEvent[],
	taskId: string,
	until: number,
	verdict: { at: number; resetAt: string | null },
): CardHistory {
	const resetAt = verdict.resetAt ? time(verdict.resetAt) : Number.NEGATIVE_INFINITY;
	let failTimes: number[] = [];
	let lastReworkModel: string | null = null;
	let extraRounds = 0;
	let handbacks = 0;
	let reworks = 0;
	let escalations = 0;
	for (const event of events) {
		const eventAt = time(event.at);
		if (event.taskId !== taskId || eventAt > until) {
			continue;
		}
		const { action } = event;
		if ((action.kind === "verdict" && action.verdict === "FAIL") || action.kind === "conflict") {
			if (eventAt <= verdict.at && eventAt >= resetAt) {
				failTimes.push(eventAt);
			}
		} else if (action.kind === "handback") {
			handbacks += 1;
			extraRounds += action.extraRounds;
		} else if (action.kind === "rework") {
			reworks += 1;
			if (lastReworkModel !== null && action.model !== null && action.model !== lastReworkModel) {
				failTimes = failTimes.slice(-1);
			}
			lastReworkModel = action.model ?? lastReworkModel;
		} else if (action.kind === "escalated") {
			escalations += 1;
		}
	}
	const failRounds = failTimes.map((_, index) => index + 1);
	return { failRounds, reworks, nudges: 0, escalations, handbacks, extraRounds };
}

interface RecoveryView {
	kind: "nudge" | "hold" | "cancel_hung" | "escalate";
	cause: string | null;
}

function readRecoveryAnswer(answer: unknown): RecoveryView | null {
	if (!isRecord(answer)) {
		return null;
	}
	const kind = answer.kind;
	if (kind !== "nudge" && kind !== "hold" && kind !== "cancel_hung" && kind !== "escalate") {
		return null;
	}
	return { kind, cause: typeof answer.cause === "string" ? answer.cause : null };
}

function describeRecovery(view: RecoveryView): string {
	return view.cause ? `${view.kind} (${view.cause})` : view.kind;
}

function compareRecovery(input: ShadowDiffInput, events: readonly LegacyCardEvent[]): ShadowDiffItem[] {
	const episodes = collapseEpisodes(
		input.decisions.filter((record) => record.stage === "recovery"),
		(record) => {
			const view = readRecoveryAnswer(record.answer);
			return view ? JSON.stringify([view.kind, view.cause]) : null;
		},
	);
	const items: ShadowDiffItem[] = [];
	for (const event of events) {
		const { action } = event;
		if (action.kind !== "nudge" && action.kind !== "hold") {
			continue;
		}
		const at = time(event.at);
		const candidates = episodes.filter((episode) => readRecoveryAnswer(episode.record.answer)?.kind === action.kind);
		const episode = findEpisode(candidates, event.taskId, at, input.windowMs);
		const legacy = action.kind === "nudge" ? `nudge (${action.cause}): ${event.text}` : `hold: ${event.text}`;
		const base = { category: "recovery" as const, taskId: event.taskId, at: event.at };
		if (!episode) {
			items.push({ ...base, status: "legacy_only", legacy, pipeline: "no recovery decision", note: null });
			continue;
		}
		episode.matched = true;
		const view = readRecoveryAnswer(episode.record.answer) as RecoveryView;
		const sameCause = action.kind !== "nudge" || view.cause === action.cause;
		items.push({
			...base,
			status: sameCause ? "same" : "different",
			legacy,
			pipeline: `${describeRecovery(view)}: ${episode.record.note}`,
			note: null,
		});
	}
	for (const episode of episodes) {
		if (!episode.matched) {
			const view = readRecoveryAnswer(episode.record.answer) as RecoveryView;
			items.push({
				category: "recovery",
				status: "pipeline_only",
				taskId: episode.taskId,
				at: episode.record.at,
				legacy: "no recovery action",
				pipeline: `${describeRecovery(view)}: ${episode.record.note}`,
				note: null,
			});
		}
	}
	return items;
}

const RESTART_NOTE = /^Kanban started (\S+?):? .*?(\d+) orphaned card\(s\)/u;

interface RestartSide {
	start: string;
	at: string;
	orphans: string[];
}

/**
 * Autoland's Kanban starts, without the ones that were never a server. Autoland takes the newest `node …/kanban …
 * --port` process in /proc as the server's start, so a short-lived one (a second `kanban --port …` that finds the
 * port taken and exits) reads as a restart, and once it is gone the next line names the old start again with that
 * phantom as "last saw" (09:08:25Z on 2026-10-07, 4 min after the real start at 09:04:23). Real starts only move
 * forward, so a line whose start is older than the one it last saw is such a revert.
 * Ported from archive/devteam-kit:lib/restart-recovery.mjs@a2b4695 (kanbanStartMs).
 */
function readLegacyStarts(input: ShadowDiffInput): {
	starts: RestartSide[];
	phantoms: Array<RestartSide & { revertAt: string; backTo: string }>;
} {
	const events = input.legacy.restarts.filter((restart) => restart.workspaceId === input.workspaceId);
	const reverts = events.filter(
		(event) => event.lastSeenStartedAt !== null && time(event.serverStartedAt) < time(event.lastSeenStartedAt),
	);
	const starts: RestartSide[] = [];
	const phantoms: Array<RestartSide & { revertAt: string; backTo: string }> = [];
	const seen = new Set<string>();
	for (const event of events) {
		if (reverts.includes(event) || seen.has(event.serverStartedAt)) {
			continue;
		}
		seen.add(event.serverStartedAt);
		const side = { start: event.serverStartedAt, at: event.at, orphans: event.orphans };
		const revert = reverts.find(
			(candidate) => candidate.lastSeenStartedAt === event.serverStartedAt && time(candidate.at) >= time(event.at),
		);
		if (revert) {
			phantoms.push({ ...side, revertAt: revert.at, backTo: revert.serverStartedAt });
		} else {
			starts.push(side);
		}
	}
	return { starts, phantoms };
}

function readPipelineStarts(input: ShadowDiffInput): RestartSide[] {
	const restartRecords = input.decisions.filter((record) => record.stage === "restart");
	const starts: RestartSide[] = [];
	for (const record of restartRecords) {
		const match = record.taskId === null ? RESTART_NOTE.exec(record.note) : null;
		if (!match || starts.some((side) => side.start === match[1])) {
			continue;
		}
		const at = time(record.at);
		const orphans = restartRecords
			.filter(
				(orphan) =>
					orphan.taskId !== null &&
					isRecord(orphan.answer) &&
					orphan.answer.kind === "resume" &&
					time(orphan.at) >= at &&
					time(orphan.at) - at <= RESTART_GROUP_MS,
			)
			.map((orphan) => orphan.taskId as string);
		starts.push({ start: match[1] as string, at: record.at, orphans: [...new Set(orphans)] });
	}
	return starts;
}

function compareRestarts(input: ShadowDiffInput): ShadowDiffItem[] {
	const legacy = readLegacyStarts(input);
	const pipelineStarts = readPipelineStarts(input);
	const describe = (side: RestartSide) =>
		`Kanban start ${side.start}: ${side.orphans.length === 0 ? "no orphaned dev cards" : `resumes ${[...side.orphans].sort().join(", ")}`}`;
	const items: ShadowDiffItem[] = [];
	const matched = new Set<RestartSide>();
	for (const side of legacy.starts) {
		const pipeline = pipelineStarts
			.filter((candidate) => !matched.has(candidate))
			.map((candidate) => ({ candidate, gap: Math.abs(time(candidate.start) - time(side.start)) }))
			.filter(({ gap }) => gap <= RESTART_START_MATCH_MS)
			.sort((a, b) => a.gap - b.gap)[0]?.candidate;
		const base = { category: "restart" as const, taskId: null, at: side.at };
		if (!pipeline) {
			// The pipeline logs a start only when it finds orphans (recovery-stage.ts). Its worker starts with the server
			// and logs a `worker` record, which says it was there to see this one (unless its recovery was off).
			const watched =
				side.orphans.length === 0 &&
				input.decisions.some(
					(record) =>
						record.stage === "worker" &&
						!/\brecovery off\b/u.test(record.note) &&
						time(record.at) >= time(side.start) &&
						time(record.at) - time(side.start) <= input.windowMs,
				);
			items.push(
				watched
					? {
							...base,
							status: "same",
							legacy: describe(side),
							pipeline: "no orphaned dev cards (a start without orphans isn't logged)",
							note: null,
						}
					: { ...base, status: "legacy_only", legacy: describe(side), pipeline: "not seen", note: null },
			);
			continue;
		}
		matched.add(pipeline);
		const same =
			side.orphans.length === pipeline.orphans.length &&
			side.orphans.every((taskId) => pipeline.orphans.includes(taskId));
		items.push({
			...base,
			status: same ? "same" : "different",
			legacy: describe(side),
			pipeline: describe(pipeline),
			note: null,
		});
	}
	for (const side of pipelineStarts) {
		if (!matched.has(side)) {
			items.push({
				category: "restart",
				status: "pipeline_only",
				taskId: null,
				at: side.at,
				legacy: "not seen",
				pipeline: describe(side),
				note: null,
			});
		}
	}
	for (const phantom of legacy.phantoms) {
		// A phantom with orphans means autoland may have resumed cards that were never orphaned: that stays a difference.
		items.push({
			category: "restart",
			status: phantom.orphans.length === 0 ? "known" : "legacy_only",
			taskId: null,
			at: phantom.at,
			legacy: describe(phantom),
			pipeline: "not seen",
			note: `not a Kanban start: a short-lived \`kanban --port\` process autoland took for the server; at ${phantom.revertAt} it saw ${phantom.backTo} again`,
		});
	}
	return items;
}

function compareDevAssignments(input: ShadowDiffInput): ShadowDiffItem[] {
	return input.devAssignments.flatMap((entry): ShadowDiffItem[] => {
		const proposed = `${entry.proposal.agentId} with ${entry.proposal.agentSettings?.modelId ?? "its default model"}`;
		const createdAgent = entry.created.agentId ?? input.selectedAgentId;
		const createdModel = entry.created.agentSettings?.modelId ?? null;
		const created = `${createdAgent} with ${createdModel ?? "its default model"}`;
		const proposedModel = entry.proposal.agentSettings?.modelId ?? null;
		const same =
			entry.proposal.agentId === createdAgent && (proposedModel === null || proposedModel === createdModel);
		return [
			{
				category: "dev_assignment",
				status: same ? "same" : "different",
				taskId: entry.taskId,
				at: entry.at,
				legacy: `created on ${created}${entry.outcome === "explicit" ? " (set by its creator)" : ""}`,
				pipeline: `kit "${entry.kit}" proposes ${proposed}${entry.proposal.tier ? ` (${entry.proposal.tier})` : ""}`,
				note: null,
			},
		];
	});
}

function countBy<T>(values: readonly T[], keyOf: (value: T) => string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) {
		const key = keyOf(value);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/** Which workspace each legacy card event is about: autoland's board events say, else this workspace's board. */
function legacyEventsOf(input: ShadowDiffInput, cards: Map<string, RuntimeBoardCard>): LegacyCardEvent[] {
	const workspaceOf = new Map<string, string>();
	for (const event of input.legacy.boardEvents) {
		workspaceOf.set(event.taskId, event.workspaceId);
	}
	return input.legacy.cards.filter((event) => {
		const workspace = workspaceOf.get(event.taskId);
		return workspace ? workspace === input.workspaceId : cards.has(event.taskId);
	});
}

export function computeShadowDiff(input: ShadowDiffInput): ShadowDiffReport {
	const inWindow = (at: string) => time(at) >= input.since && time(at) <= input.until;
	const cards = boardCards(input.board);
	const allCardEvents = legacyEventsOf(input, cards);
	const events = allCardEvents.filter((event) => inWindow(event.at));
	const scoped: ShadowDiffInput = {
		...input,
		decisions: input.decisions.filter((record) => record.workspaceId === input.workspaceId && inWindow(record.at)),
		devAssignments: input.devAssignments.filter(
			(entry) => entry.workspaceId === input.workspaceId && inWindow(entry.at),
		),
		legacy: { ...input.legacy, restarts: input.legacy.restarts.filter((restart) => inWindow(restart.at)) },
	};
	const items = [
		...compareQaRouting(scoped, events, cards),
		...compareOnFail(scoped, events, allCardEvents, cards),
		...compareRecovery(scoped, events),
		...compareRestarts(scoped),
		...compareDevAssignments(scoped),
	].sort((a, b) => time(a.at) - time(b.at));
	return {
		workspaceId: input.workspaceId,
		kitName: input.kitName,
		since: new Date(input.since).toISOString(),
		until: new Date(input.until).toISOString(),
		items,
		counts: {
			legacy: countBy(events, (event) => event.action.kind),
			pipeline: countBy(scoped.decisions, (record) => `${record.stage}:${record.outcome}`),
		},
		unexplained: items.filter((item) => UNEXPLAINED_STATUSES.includes(item.status)).length,
	};
}
