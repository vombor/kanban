// A dev card whose settled Review has nothing to submit: its snapshot equals its base (issue #14, notes b2d5b
// 2026-10-09: the scaffold was already on main, the agent saw that and ended its turn; the card sat in Review with no
// QA, no Done and no alert, and its linked Backlog card never started).
//
// The submission stage records it on the card's pipeline-state entry (`emptyDiff`) and the watchdog reports it
// (stalls.ts), so the orchestrator or the user decides: Done (which starts the card's linked Backlog cards) or a
// restart. Nothing moves the card by itself. Whether the agent ran is decided from Kanban's own evidence of a turn
// (a hook of this run, a turn end through a hook, a final message), never from PTY output: an idle TUI repaints, and
// a startup or sign-in screen prints plenty without ever taking the prompt.
import type { RuntimeBoardCard } from "../core/api-contract";
import type { PipelineSessionView } from "./engine";
import type { PipelineCardState } from "./pipeline-state";

/** The pipeline-state field the submission stage writes; a submission with changes removes it. */
export const EMPTY_DIFF_FIELD = "emptyDiff";

export interface EmptyDiffRecord {
	/** When the submission stage found it. */
	at: string;
	/** The card's `updatedAt` at that submission: a record for an older submission no longer describes the card. */
	cardUpdatedAt: number | null;
	snapshot: string;
	parent: string | null;
	baseRef: string;
	/** The agent took its prompt in this run (`evidence` says how); false: no turn of it is on record. */
	ran: boolean;
	evidence: string;
}

export interface TurnEvidence {
	ran: boolean;
	evidence: string;
}

/** Whether the session's agent took a turn in this run, from Kanban's hook evidence. */
export function describeTurnEvidence(session: PipelineSessionView | null): TurnEvidence {
	if (!session) {
		return { ran: false, evidence: "no session" };
	}
	if (session.reviewReason === "hook") {
		return { ran: true, evidence: "its turn ended through the agent's hook" };
	}
	if (session.latestHookActivity?.finalMessage) {
		return { ran: true, evidence: "the agent sent a final message" };
	}
	const hookAt = session.lastHookAt ?? null;
	if (hookAt !== null && (session.startedAt == null || hookAt >= session.startedAt)) {
		return {
			ran: true,
			evidence: `the agent's hooks reported activity (${session.latestHookActivity?.hookEventName ?? "a hook"} at ${new Date(hookAt).toISOString()})`,
		};
	}
	return {
		ran: false,
		evidence: `no hook or final message from this run (session ${session.state}, reviewReason ${session.reviewReason ?? "none"})`,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The card's `emptyDiff` record, or null when there is none or it is malformed. */
export function readEmptyDiff(entry: PipelineCardState | undefined): EmptyDiffRecord | null {
	const value = entry?.[EMPTY_DIFF_FIELD];
	if (
		!isRecord(value) ||
		typeof value.at !== "string" ||
		typeof value.snapshot !== "string" ||
		typeof value.baseRef !== "string" ||
		typeof value.ran !== "boolean"
	) {
		return null;
	}
	return {
		at: value.at,
		cardUpdatedAt: typeof value.cardUpdatedAt === "number" ? value.cardUpdatedAt : null,
		snapshot: value.snapshot,
		parent: typeof value.parent === "string" ? value.parent : null,
		baseRef: value.baseRef,
		ran: value.ran,
		evidence: typeof value.evidence === "string" ? value.evidence : "",
	};
}

/** The record if it describes the card's current submission (the card hasn't been moved or edited since). */
export function readCurrentEmptyDiff(
	entry: PipelineCardState | undefined,
	card: Pick<RuntimeBoardCard, "updatedAt">,
): EmptyDiffRecord | null {
	const record = readEmptyDiff(entry);
	return record && record.cardUpdatedAt === card.updatedAt ? record : null;
}
