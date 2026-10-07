// The pipeline engine: which cards of a workspace the pipeline looks at, and what it asks the workspace's kit.
//
// Two rules from the 2026-10-06 incident (plan §4.0) hold for everything here:
//
// - The core resolves, the kit decides. Every card goes to the kit as an EffectiveCard whose agent comes from
//   resolveEffectiveAgent() (the agent the session ran on, else card.agentId, else the selected agent), never the
//   literal card.agentId, and nothing here compares an agent id to a constant. On kanban-2uge the legacy kit
//   treated unpinned cards that ran on Claude as Cline dev cards and QA'd and landed them.
// - Only landing mode `qa` turns the pipeline on for a workspace. Landing `off`, `commit` or `pr` (and every
//   workspace without a config entry: `off` on the `default` kit) is never evaluated: no git probe, no kit
//   question, no decision. `commit`/`pr` cards stay with the auto-review reconciler.
//
// For each Review card it runs the submission stage (submission-stage.ts: snapshot, scripted checks), then asks the
// QA-gate question (`qaPolicy`) for each submitted card and records the answer. A `qa` answer goes to the QA gate
// (qa-gate.ts, through `submitQa`) unless the workspace is in shadow. The rework loop (rework.ts) acts on what the
// gate records after a FAIL, and recovery (recovery.ts, recovery-stage.ts) continues crashed and stopped cards. A
// decision without a stage to act on it is logged as `not_implemented` (or `shadow` on a shadow workspace).

import type { PipelineConfig, WorkspacePipelineSettings } from "../config/pipeline-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import {
	type EffectiveModelConfig,
	resolveEffectiveAgentWithSource,
	resolveEffectiveModel,
} from "../core/effective-agent";
import type { CardHistory, EffectiveCard, QaPolicyAnswer, RoutingPolicy } from "../kits/policy";
import { isReviewSettled } from "../terminal/review-settle";
import type { PipelineDecisionOutcome, PipelineDecisionRecord } from "./decision-log";
import type { PipelineCardState, PipelineWorkspaceState } from "./pipeline-state";
import { recoveryHoldReason, recoveryRedoReason } from "./recovery";
import type { SubmissionCardInput, SubmissionInspection } from "./submission-stage";

export type PipelineSessionView = Pick<RuntimeTaskSessionSummary, "taskId" | "agentId" | "modelId" | "state"> &
	// What the watchdog reads (stalls, stuck prompts, the orchestrator sidebar's liveness); the server sends them.
	Partial<
		Pick<
			RuntimeTaskSessionSummary,
			| "pid"
			| "startedAt"
			| "updatedAt"
			| "stateChangedAt"
			| "lastOutputAt"
			| "lastHookAt"
			| "latestHookActivity"
			| "reviewReason"
			| "warningMessage"
			| "workspacePath"
			| "exitCode"
		>
	> & {
		/** The session has a process (a TUI to type into). False for a summary hydrated after a restart. */
		live?: boolean;
	};

/** What the server sends the worker about one workspace. */
export interface PipelineWorkspaceSnapshot {
	workspaceId: string;
	workspacePath: string;
	board: RuntimeBoardData;
	sessions: PipelineSessionView[];
	/** The agent selected in Kanban settings for this workspace (the effective agent of a card with none). */
	selectedAgentId: RuntimeAgentId;
	/** When this Kanban server started (epoch ms): sessions started before it lost their process (restart recovery). */
	serverStartedAt?: number;
	/** The start of the server that ran before this one (its start record), or null: a restart manifest it wrote is the only one used. */
	previousServerStartedAt?: number | null;
	/** `sessionSync.reviewSettleSec` in ms, as the server read it at start (isReviewSettled, src/terminal/review-settle.ts). */
	reviewSettleMs?: number;
	/**
	 * A PID pressure flag is set (src/state/pid-pressure-flags.ts, read by the server when it sends the snapshot): the
	 * QA gate creates and starts no QA cards and restart recovery resumes no cards until it clears.
	 */
	pidPressure?: boolean;
}

export interface PipelineEvaluationInput {
	snapshot: PipelineWorkspaceSnapshot;
	settings: WorkspacePipelineSettings;
	kitName: string;
	policy: RoutingPolicy;
	state: PipelineWorkspaceState;
	limits: { maxFailRounds: number };
	/** `pipeline.recovery.nudgeCheckSec` in ms: how long a turn recovery resent is held back (recoveryRedoReason). */
	recoveryNudgeCheckMs: number;
	agentDefaultModels?: EffectiveModelConfig["agentDefaultModels"];
	/** The submission stage for one Review card (snapshot, checks, has it work). Only called on a `qa` workspace. */
	inspectSubmission: (input: SubmissionCardInput) => Promise<SubmissionInspection>;
	/** The QA gate for a `qa` answer outside shadow. Absent: the decision is logged as `not_implemented`. */
	submitQa?: (input: {
		card: RuntimeBoardCard;
		session: PipelineSessionView | null;
		dev: EffectiveCard;
		answer: Extract<QaPolicyAnswer, { kind: "qa" }>;
	}) => Promise<{ outcome: PipelineDecisionOutcome; note: string }>;
	now: number;
}

/** The pipeline runs for a workspace only with landing mode `qa` (shadow or not). */
export function isPipelineWorkspace(settings: WorkspacePipelineSettings): boolean {
	return settings.landing.mode === "qa";
}

/** Whether recovery evaluates a workspace at all, and whether it acts there. */
export function getRecoveryScope(
	config: PipelineConfig,
	settings: WorkspacePipelineSettings,
): { evaluate: boolean; act: boolean } {
	const mode = config.pipeline.recovery.mode;
	if (mode === "off" || !settings.recovery.enabled) {
		return { evaluate: false, act: false };
	}
	// "report" stays on pipeline workspaces (landing qa), so a workspace on landing off is never touched by it.
	if (mode === "report") {
		return { evaluate: settings.landing.mode === "qa", act: false };
	}
	return { evaluate: true, act: !settings.pipeline.shadow };
}

/**
 * Review cards the pipeline gates: every card except those the auto-review reconciler owns (auto-review on with
 * `commit` or `pr`). On a `qa` workspace a card's own mode only matters for that exception.
 */
export function isPipelineCandidate(card: RuntimeBoardCard): boolean {
	return !(card.autoReviewEnabled === true && card.autoReviewMode !== "qa");
}

export function toEffectiveCard(input: {
	card: RuntimeBoardCard;
	session: PipelineSessionView | null;
	workspaceId: string;
	selectedAgentId: RuntimeAgentId;
	agentDefaultModels?: EffectiveModelConfig["agentDefaultModels"];
}): { effective: EffectiveCard; agentSource: PipelineDecisionRecord["effectiveAgent"] } {
	const config: EffectiveModelConfig = {
		selectedAgentId: input.selectedAgentId,
		agentDefaultModels: input.agentDefaultModels,
	};
	const agent = resolveEffectiveAgentWithSource(input.card, input.session, config);
	return {
		effective: {
			card: input.card,
			workspaceId: input.workspaceId,
			// A legacy-kit QA/TRIAGE/calibration card has no role; resolveCardRole reads its creation markers.
			role: resolveCardRole(input.card),
			agentId: agent.agentId,
			model: resolveEffectiveModel(input.card, input.session, config),
		},
		agentSource: agent,
	};
}

function readNumberArray(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : [];
}

function countEntries(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/**
 * A card's history from its pipeline-state entry (the legacy `qaflow` fields). Ported from
 * archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (flowState, maxFailsOf: each handback grants its
 * `extraRounds`).
 */
export function readCardHistory(entry: PipelineCardState | undefined): { history: CardHistory; round: number } {
	const qaflow = entry?.qaflow;
	const flow =
		qaflow && typeof qaflow === "object" && !Array.isArray(qaflow) ? (qaflow as Record<string, unknown>) : {};
	const handbacks = Array.isArray(flow.handbacks) ? flow.handbacks : [];
	const extraRounds = handbacks.reduce<number>((sum, handback) => {
		const extra =
			handback && typeof handback === "object" ? Number((handback as { extraRounds?: unknown }).extraRounds) : 0;
		return sum + (Number.isFinite(extra) && extra > 0 ? extra : 0);
	}, 0);
	const lastRound = typeof flow.lastRound === "number" ? flow.lastRound : 0;
	return {
		history: {
			failRounds: readNumberArray(flow.failRounds),
			reworks: countEntries(flow.reworks),
			nudges: countEntries(flow.nudges),
			escalations: flow.escalated ? 1 : 0,
			handbacks: handbacks.length,
			extraRounds,
		},
		round: lastRound + 1,
	};
}

/** Why QA waits for a card whose Review hasn't settled (isReviewSettled). */
export function describeUnsettledReview(session: PipelineSessionView | null): string {
	return session?.state === "running"
		? "the session is still running; QA waits for the turn to end"
		: "the turn ended moments ago; QA waits for the Review to settle";
}

/** When the card was escalated (`qaflow.escalated.at`, written by the rework loop), or null; a handback clears it. */
export function readEscalatedAt(entry: PipelineCardState | undefined): string | null {
	const qaflow = entry?.qaflow;
	if (!qaflow || typeof qaflow !== "object" || Array.isArray(qaflow)) {
		return null;
	}
	const escalated = (qaflow as Record<string, unknown>).escalated;
	if (!escalated) {
		return null;
	}
	const at = typeof escalated === "object" ? (escalated as { at?: unknown }).at : undefined;
	return typeof at === "string" ? at : "(unknown time)";
}

function describeQaAnswer(answer: QaPolicyAnswer): string {
	if (answer.kind === "none") {
		return `no QA: ${answer.reason}; the card waits for Approve & land`;
	}
	const model = answer.model ? ` on ${answer.model.model}` : "";
	return `QA by ${answer.agentId}${model} (${answer.route ?? "qa.default"})`;
}

export async function evaluatePipelineWorkspace(input: PipelineEvaluationInput): Promise<PipelineDecisionRecord[]> {
	const { snapshot, settings } = input;
	if (!isPipelineWorkspace(settings)) {
		return [];
	}
	const sessions = new Map(snapshot.sessions.map((session) => [session.taskId, session]));
	const review = snapshot.board.columns.find((column) => column.id === "review")?.cards ?? [];
	const shadow = settings.pipeline.shadow;
	const at = new Date(input.now).toISOString();
	const decisions: PipelineDecisionRecord[] = [];
	for (const card of review) {
		const session = sessions.get(card.id) ?? null;
		// Recovery logs its own decision for a card it holds or whose turn it just resent (recovery-stage.ts). It runs
		// before this in the same evaluation, so a turn it decided to redo is never snapshotted or QA'd.
		const entry = input.state.cards[card.id];
		if (
			!isPipelineCandidate(card) ||
			recoveryHoldReason(entry) ||
			recoveryRedoReason(entry, session, input.now, input.recoveryNudgeCheckMs)
		) {
			continue;
		}
		const { effective, agentSource } = toEffectiveCard({
			card,
			session,
			workspaceId: snapshot.workspaceId,
			selectedAgentId: snapshot.selectedAgentId,
			agentDefaultModels: input.agentDefaultModels,
		});
		const common = {
			at,
			workspaceId: snapshot.workspaceId,
			taskId: card.id,
			kit: input.kitName,
			landingMode: settings.landing.mode,
			shadow,
			effectiveAgent: agentSource,
			model: effective.model,
			role: effective.role,
		};
		// An escalated card waits for a human (BLOCKED in Backlog). If it is back in Review without a handback (started
		// by hand, or by a board link), it is never QA'd or landed: a sibling may have taken its task over.
		const escalatedAt = readEscalatedAt(input.state.cards[card.id]);
		if (escalatedAt) {
			decisions.push({
				...common,
				stage: "qa_gate",
				answer: null,
				outcome: "none",
				note: `escalated ${escalatedAt}: not QA'd or landed until \`kanban task handback\` gives it back to the pipeline`,
			});
			continue;
		}
		// A Review that hasn't settled may still resume (src/terminal/review-settle.ts): no snapshot, no QA yet. The
		// worker host sends a snapshot once it has settled.
		if (!isReviewSettled(session, input.now, snapshot.reviewSettleMs)) {
			decisions.push({
				...common,
				stage: "qa_gate",
				answer: null,
				outcome: "none",
				note: describeUnsettledReview(session),
			});
			continue;
		}
		const submission = await input.inspectSubmission({ card, effective, session });
		for (const record of submission.records) {
			decisions.push({ ...common, ...record, answer: null });
		}
		if (!submission.hasWork) {
			continue;
		}
		const { history, round } = readCardHistory(input.state.cards[card.id]);
		const answer = input.policy.qaPolicy({ dev: effective, round, history });
		let outcome: PipelineDecisionOutcome = answer.kind === "none" ? "none" : shadow ? "shadow" : "not_implemented";
		let note = `round ${round}: ${describeQaAnswer(answer)}`;
		if (answer.kind === "qa" && !shadow && input.submitQa) {
			const gated = await input.submitQa({ card, session, dev: effective, answer });
			outcome = gated.outcome;
			note = `${note}; ${gated.note}`;
		}
		decisions.push({
			...common,
			stage: "qa_gate",
			answer,
			outcome,
			note,
		});
	}
	return decisions;
}
