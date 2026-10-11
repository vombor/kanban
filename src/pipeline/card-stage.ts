// The board's pipeline card stages (issue #30): where the pipeline is with each dev card of a landing-`qa` board,
// short enough for a badge on a phone. A Review card used to look idle while its checks ran for ten minutes, and the
// user took it for stuck and used Approve & land, which skipped QA (foo 8c28e, 2026-10-11).
//
// Nothing here decides anything: it reads what the stages already decided and keep. The engine's outcome for each
// Review card in the worker's last evaluation (engine.ts `onCardOutcome`: settling, escalated, the snapshot it
// submitted and the kit's QA answer), the card's pipeline-state entry (recovery holds, the checks wait, the QA card,
// verdicts, reworks, holds), the checks runner's queue (checks.ts `status`) and why each queued QA card waited at the
// QA gate's last tick (qa-gate.ts `describeQueueWaits`). The worker sends the result to the server
// (worker-protocol.ts `cardStages`), and the server to that workspace's board clients only.
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimePipelineCardStage } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { type ChecksRunnerStatus, findCardChecks } from "./checks";
import { isPipelineCandidate, type PipelineCardOutcome, type PipelineSessionView } from "./engine";
import { readPipelineHold } from "./hold";
import { type PipelineCardState, type PipelineWorkspaceState, readEscalatedAt } from "./pipeline-state";
import { readQaChecksWaitDeadline } from "./qa-checks-report";
import { findRunningQaCard, type QaQueueWait, readQaGateEntry, readQaPassEntry, readQaVerdictRecords } from "./qa-gate";
import { recoveryHoldReason, recoveryRedoReason } from "./recovery";
import { readEscalationRecord, readQaflow, readReworks } from "./rework";
import { readOpenRework } from "./rework-state";

export interface PipelineCardStagesInput {
	columns: ReadonlyArray<{ id: RuntimeBoardColumnId; cards: readonly RuntimeBoardCard[] }>;
	sessions: readonly PipelineSessionView[];
	state: PipelineWorkspaceState;
	/** The engine's outcome per Review card in the last evaluation. */
	outcomes: ReadonlyMap<string, PipelineCardOutcome>;
	/** The checks runner's status, or null when it doesn't report one. */
	checks: ChecksRunnerStatus | null;
	workspaceId: string;
	/** Why each queued QA card waited at the QA gate's last tick (qaTaskId → wait). */
	queueWaits: ReadonlyMap<string, QaQueueWait>;
	/** `pipeline.qa.checksWaitMin`. */
	checksWaitMin: number;
	/** `pipeline.recovery.nudgeCheckSec` in ms. */
	recoveryNudgeCheckMs: number;
	pidPressure: boolean;
	now: number;
}

type Stage = Omit<RuntimePipelineCardStage, "taskId">;

function stage(kind: Stage["kind"], label: string, fields: Partial<Omit<Stage, "kind" | "label">> = {}): Stage {
	return {
		kind,
		label,
		next: fields.next ?? null,
		qaTaskId: fields.qaTaskId ?? null,
		deadline: fields.deadline ?? null,
		detail: fields.detail ?? null,
		inFlight: fields.inFlight ?? false,
	};
}

function describeQueuedQa(qaTaskId: string, round: number, wait: QaQueueWait | undefined): Stage {
	const fields = { qaTaskId, inFlight: true, detail: wait?.note || null };
	if (wait?.kind === "slot") {
		return stage("qa_queued", "Waiting for QA slot", { ...fields, next: `QA r${round}` });
	}
	if (wait?.kind === "capacity") {
		return stage("qa_queued", `Waiting for ${wait.provider ?? "provider"} capacity`, {
			...fields,
			next: `QA r${round}`,
		});
	}
	if (wait?.kind === "paused") {
		return stage("qa_queued", "QA paused", { ...fields, next: `QA r${round} on resume` });
	}
	if (wait?.kind === "pid_pressure") {
		return stage("qa_queued", "QA held: PID pressure", { ...fields, next: `QA r${round}` });
	}
	return stage("qa_queued", `QA r${round} queued`, fields);
}

function describeVerdict(entry: PipelineCardState | undefined, snapshot: string): Stage | null {
	const verdict = readQaVerdictRecords(entry)
		.filter((record) => record.snapshot === snapshot)
		.at(-1);
	if (!verdict) {
		return null;
	}
	const fields = {
		qaTaskId: verdict.qaTaskId,
		detail: verdict.blocking.length > 0 ? verdict.blocking.join("; ") : null,
	};
	if (verdict.verdict !== "PASS") {
		return stage("qa_verdict", `QA r${verdict.round} ${verdict.verdict}`, { ...fields, next: "rework next" });
	}
	const pass = readQaPassEntry(entry);
	const conflict = pass?.snapshot === snapshot && pass.landing?.decision === "conflict";
	return stage("qa_verdict", `QA r${verdict.round} PASS`, {
		...fields,
		next: conflict ? "land conflict · rework next" : pass?.action === "stale" ? "changed since QA" : "landing",
	});
}

/** The stage of a Review dev card whose snapshot the engine submitted. */
function describeSubmitted(
	input: PipelineCardStagesInput,
	taskId: string,
	outcome: Extract<PipelineCardOutcome, { kind: "submitted" }>,
): Stage {
	const entry = input.state.cards[taskId];
	const { snapshot } = outcome;
	const deadline = snapshot ? readQaChecksWaitDeadline(entry, input.checksWaitMin, snapshot) : null;
	const next = outcome.qa ? "QA next" : "Approve & land";
	const checks = describeChecks(input, taskId, { next, deadline });
	if (checks) {
		return checks;
	}
	if (!outcome.qa) {
		return stage("no_qa", "No QA", { next: "Approve & land", detail: outcome.reason });
	}
	if (!snapshot) {
		return stage("qa_next", "QA next", { inFlight: true });
	}
	const qaTaskId = entry?.qaCreated === snapshot && typeof entry.qaCard === "string" ? entry.qaCard : null;
	const qaEntry = qaTaskId ? readQaGateEntry(input.state.cards[qaTaskId]) : null;
	if (qaTaskId && qaEntry?.status === "queued") {
		return describeQueuedQa(qaTaskId, qaEntry.round, input.queueWaits.get(qaTaskId));
	}
	const running = findRunningQaCard({
		cards: input.state.cards,
		devTaskId: taskId,
		columnOf: (id) => input.columns.find((column) => column.cards.some((card) => card.id === id))?.id ?? null,
		snapshot,
	});
	if (running) {
		return stage("qa_running", `QA r${running.entry.round} running`, { qaTaskId: running.qaTaskId, inFlight: true });
	}
	const verdict = describeVerdict(entry, snapshot);
	if (verdict) {
		return verdict;
	}
	if (deadline !== null) {
		return stage("qa_waiting_checks", "Waiting for checks", { next: "QA next", deadline, inFlight: true });
	}
	if (input.pidPressure) {
		return stage("qa_next", "QA next", {
			detail: "PID pressure: no QA card is created until it clears",
			inFlight: true,
		});
	}
	return stage("qa_next", "QA next", { inFlight: true });
}

/** The card's checks while the runner has them: running (with its step) or queued. */
function describeChecks(
	input: PipelineCardStagesInput,
	taskId: string,
	fields: { next: string | null; deadline: number | null },
): Stage | null {
	const checks = findCardChecks(input.checks, input.workspaceId, taskId);
	if (!checks) {
		return null;
	}
	if (checks.kind === "running") {
		return stage("checks_running", `Checks running${checks.step ? ` (${checks.step})` : ""}`, {
			...fields,
			inFlight: true,
		});
	}
	return stage("checks_queued", "Checks queued", {
		...fields,
		detail: checks.ahead > 0 ? `${checks.ahead} card(s) ahead in the machine-wide checks queue` : null,
		inFlight: true,
	});
}

function describeReviewCard(
	input: PipelineCardStagesInput,
	card: RuntimeBoardCard,
	session: PipelineSessionView | null,
): Stage | null {
	const entry = input.state.cards[card.id];
	const escalatedAt = readEscalatedAt(entry);
	if (escalatedAt) {
		return stage("escalated", "Escalated", {
			next: "waits for handback",
			detail: readEscalationRecord(readQaflow(entry))?.reason ?? `escalated ${escalatedAt}`,
		});
	}
	const stopped = readQaflow(entry).stopped;
	if (stopped && typeof stopped === "object") {
		const reason = (stopped as { reason?: unknown }).reason;
		return stage("stopped", "Stopped", { next: "waits for you", detail: typeof reason === "string" ? reason : null });
	}
	const recovery =
		recoveryHoldReason(entry) ?? recoveryRedoReason(entry, session, input.now, input.recoveryNudgeCheckMs);
	if (recovery) {
		return stage("recovery", "Recovery", { detail: recovery });
	}
	const hold = readPipelineHold(entry);
	if (hold) {
		return stage("held", "Held", { next: "runoff decision", detail: `held for ${hold.group} since ${hold.at}` });
	}
	const outcome = input.outcomes.get(card.id);
	if (!outcome) {
		return describeChecks(input, card.id, { next: null, deadline: null });
	}
	if (outcome.kind === "interrupted") {
		return stage("recovery", "Cut off by restart", {
			detail: "its session died with the previous Kanban server; it isn't QA'd until it runs again",
		});
	}
	if (outcome.kind === "unsettled") {
		return stage("settling", outcome.running ? "Turn running" : "Settling", { next: "checks, then QA" });
	}
	if (outcome.kind === "submitted") {
		return describeSubmitted(input, card.id, outcome);
	}
	return null;
}

function describeInProgressCard(input: PipelineCardStagesInput, card: RuntimeBoardCard): Stage | null {
	const qaflow = readQaflow(input.state.cards[card.id]);
	if (!readOpenRework(qaflow)) {
		return null;
	}
	const rework = readReworks(qaflow).at(-1);
	if (!rework) {
		return null;
	}
	const label =
		rework.kind === "conflict"
			? "Conflict rework sent"
			: rework.kind === "stalled"
				? "Rework sent (QA stalled)"
				: "Rework sent";
	return stage("rework_sent", label, {
		next: `QA r${rework.next} next`,
		detail: `sent ${rework.at} after QA round ${rework.round} (${rework.kind}), to ${rework.agentId}${rework.model ? ` on ${rework.model.model}` : ""}`,
	});
}

/** The stage of every dev card in Review or In Progress the pipeline has one for. */
export function describePipelineCardStages(input: PipelineCardStagesInput): RuntimePipelineCardStage[] {
	const sessions = new Map(input.sessions.map((session) => [session.taskId, session]));
	const stages: RuntimePipelineCardStage[] = [];
	for (const column of input.columns) {
		if (column.id !== "review" && column.id !== "in_progress") {
			continue;
		}
		for (const card of column.cards) {
			if (resolveCardRole(card) !== "dev" || !isPipelineCandidate(card)) {
				continue;
			}
			const described =
				column.id === "review"
					? describeReviewCard(input, card, sessions.get(card.id) ?? null)
					: describeInProgressCard(input, card);
			if (described) {
				stages.push({ taskId: card.id, ...described });
			}
		}
	}
	return stages;
}
