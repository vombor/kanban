// A QA card whose run ended on the QA agent's own error (issue #12): no verdict, because the reviewer's model or
// provider failed, not because the dev card did. The QA gate doesn't nudge it (a nudge resends the conversation that
// keeps failing: foo QA ebeb2's 8000 px screenshot, 2026-10-09), it replaces it with a fresh QA card for the same
// snapshot up to QA_AGENT_ERROR_RETRIES times, then records a STALLED that carries the error (`qaAgentError`),
// which the rework stage escalates to the orchestrator instead of asking the kit's onFail (a takeover of the dev
// card onto `escalate.to` punished the dev card for the harness).
import type { PipelineSessionView } from "./engine";
import type { PipelineCardState } from "./pipeline-state";
import type { AgentRunError } from "./recovery-detect";
import { SMALL_IMAGES_ONLY } from "./recovery-prompts";

/** Fresh QA cards for one snapshot after QA agent errors, before the gate records STALLED. */
export const QA_AGENT_ERROR_RETRIES = 2;

/** One QA card retired for its own error (`cards[<devTaskId>].qaAgentErrors[]`). */
export interface QaAgentErrorRecord {
	qaTaskId: string;
	snapshot: string;
	round: number;
	at: number;
	/** `silent_stall`: its Cline session made no progress for recovery's `hungMin` (the QA gate's replaceSilentQaCards). */
	kind: AgentRunError["kind"] | "agent_error" | "silent_stall";
	text: string;
	/** For `image_rejected`: an image over the size limits rather than a text-only model. */
	tooLarge?: boolean;
}

export type QaAgentError = Pick<QaAgentErrorRecord, "kind" | "text" | "tooLarge">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readQaAgentErrors(entry: PipelineCardState | undefined): QaAgentErrorRecord[] {
	const records = entry?.qaAgentErrors;
	return Array.isArray(records)
		? records.filter(
				(record): record is QaAgentErrorRecord =>
					isPlainObject(record) && typeof record.snapshot === "string" && typeof record.at === "number",
			)
		: [];
}

/**
 * When the dev card was last handed back (`kanban task handback`): earlier QA agent errors and STALLED verdicts no
 * longer count.
 */
export function readLastHandbackAt(entry: PipelineCardState | undefined): number {
	const qaflow = isPlainObject(entry?.qaflow) ? entry.qaflow : {};
	const last = Array.isArray(qaflow.handbacks) ? qaflow.handbacks.at(-1) : undefined;
	const at = isPlainObject(last) && typeof last.at === "string" ? Date.parse(last.at) : Number.NaN;
	return Number.isFinite(at) ? at : 0;
}

/** The QA agent errors on `snapshot` since the dev card's last handback, oldest first. */
export function listQaAgentErrors(entry: PipelineCardState | undefined, snapshot: string): QaAgentErrorRecord[] {
	const since = readLastHandbackAt(entry);
	return readQaAgentErrors(entry).filter((record) => record.snapshot === snapshot && record.at > since);
}

/**
 * The QA card's own error from its session, or null: the Cline session's last turn (detectRunError, read by the
 * caller), else a session summary that ended on an agent error (any agent).
 */
export function resolveQaAgentError(
	runError: AgentRunError | null,
	session: PipelineSessionView | null,
): QaAgentError | null {
	if (runError) {
		return {
			kind: runError.kind,
			text: runError.text,
			...(runError.kind === "image_rejected" ? { tooLarge: runError.tooLarge } : {}),
		};
	}
	if (session?.reviewReason === "error") {
		return {
			kind: "agent_error",
			text: session.latestHookActivity?.finalMessage?.trim() || "agent error (no message)",
		};
	}
	return null;
}

export function describeQaAgentError(error: QaAgentError): string {
	const kind =
		error.kind === "image_rejected"
			? error.tooLarge
				? "image over the model's size limits"
				: "model rejects images"
			: error.kind.replace(/_/g, " ");
	const text = error.text.replace(/\s+/g, " ").trim().slice(0, 200);
	return text ? `${kind}: ${text}` : kind;
}

/**
 * Appended after the QA prompt of the QA card that replaces one retired for its own error, like the checks report:
 * the QA prompt itself stays the legacy text (team-qa-prompt.test.ts).
 */
export function buildQaAgentErrorNote(error: QaAgentError): string {
	const base = `NOTE (Kanban): an earlier QA card for this snapshot ended on its own error (${describeQaAgentError(error)}) before writing a verdict, and was replaced by this one.`;
	if (error.kind === "image_rejected" && error.tooLarge) {
		return `${base} ${SMALL_IMAGES_ONLY}`;
	}
	if (error.kind === "image_rejected") {
		return `${base} Your model doesn't accept images: never read image files (.png/.jpg/.gif/.webp); check screenshots through the screenshot tool's text report (status, console, outline) instead.`;
	}
	return base;
}
