// Why a card's agent stopped, read from its newest Cline CLI session (the detail reader in
// src/terminal/cline-session-files.ts) and Kanban's session summary. Pure: no I/O, no clock unless passed in.
// recovery.ts turns these findings into nudges, continues, retries and holds.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (POISONED, TRANSIENT, OVERFLOW,
// prematureStop, finalProviderError, overflowCulprit, hungRequest). The incident behind each rule is in
// docs/team/HISTORY.md ("Pipeline: recovery").
import {
	detectFinalProviderError,
	type FinalProviderError,
	getClineMessageText,
	hasClineToolUse,
	isContextOverflowError,
	isPoisonedHistoryError,
} from "../terminal/cline-provider-error";
import type { ClineSessionDetail, ClineSessionDetailMessage } from "../terminal/cline-session-files";
import { getClineImageRejection } from "../terminal/cline-turn-outcome";

// The final-reply error reader and its patterns live with the turn detector, which reads them too.
export { detectFinalProviderError, type FinalProviderError, isContextOverflowError, isPoisonedHistoryError };

// Provider errors worth a backoff retry rather than a nudge (daf86a5: three 5xx in 25 s escalated 0789a; 519d05f:
// stream timeouts; 6698365: "connection refused" from a restarting Lemonade).
const TRANSIENT_PATTERN =
	/stream timeout|timed out|request timeout|server had an error|temporarily unavailable|service unavailable|overloaded|bad gateway|gateway time-?out|internal server error|\b(500|502|503|504|529)\b|ECONNRESET|ECONNREFUSED|connection ?refused|unable to connect|ETIMEDOUT|socket hang up|rate.?limit|too many requests|\b429\b|throttl/i;
// A turn that ends by narrating the next step instead of doing it (9496770: Nova 2 Lite "Now let me examine the files:").
const ANNOUNCE_PATTERN =
	/(:\s*$)|\b(let me(?! know)|let's|i'll|i will|i am going to|i'm going to|now i|next,? i|i need to)\b[^.!?]*[.:]?\s*$/i;

/** 8590bad: an empty reply at the 4096-token output cap is a tool call cut off mid-write. */
export const OUTPUT_CAP_TOKENS = 4096;
/** A tool result bigger than this is named as the overflow's culprit (0a3d1fc). */
const OVERFLOW_CULPRIT_MIN_BYTES = 100_000;

/** A provider error that gets the retry backoff (and then the outage hold). A poisoned history never does. */
export function isTransientProviderError(text: string): boolean {
	return !isPoisonedHistoryError(text) && TRANSIENT_PATTERN.test(text);
}

export type PrematureStop =
	| { kind: "empty"; outputCap: boolean }
	/** `tooLarge`: the model takes images, but one was over its size limits (issue #12), not a text-only model. */
	| { kind: "no_images"; text: string; tooLarge: boolean }
	| { kind: "announcement"; text: string };

function isBlank(message: ClineSessionDetailMessage): boolean {
	return message.content.every((block) => block.type === "text" && !(block.text ?? "").trim());
}

/**
 * A turn that ended without finishing: an empty final reply (fc270f0, bd4eeff: Bedrock then rejects the empty
 * message in history, so it needs /clear), one at the output cap (8590bad), a "model doesn't support images" reply
 * (0f713ad: the image stays in history) or an "image exceeds the max size" one (issue #12, the same), or an announcement with no tool call (9496770). Null otherwise.
 */
export function detectPrematureStop(
	messages: readonly ClineSessionDetailMessage[],
	outputCap = OUTPUT_CAP_TOKENS,
): PrematureStop | null {
	const assistant = messages.filter((message) => message.role === "assistant");
	const lastAny = assistant.at(-1);
	if (lastAny && isBlank(lastAny)) {
		return { kind: "empty", outputCap: (lastAny.outputTokens ?? 0) >= outputCap };
	}
	const last = assistant.filter((message) => message.content.length > 0).at(-1);
	if (!last || hasClineToolUse(last)) {
		return null;
	}
	const text = getClineMessageText(last);
	const rejection = getClineImageRejection(text);
	if (rejection) {
		return { kind: "no_images", text: text.slice(-160), tooLarge: rejection === "too_large" };
	}
	return text && ANNOUNCE_PATTERN.test(text.slice(-200))
		? { kind: "announcement", text: text.replace(/\s+/g, " ").slice(-160) }
		: null;
}

// Lemonade's answer for a model it unloaded to load another one (`max_loaded_models`): capacity, not an outage.
const MODEL_NOT_LOADED_PATTERN = /\bno model loaded\b/i;

/**
 * A provider error that gets the retry backoff (and then the outage hold): a transient one by its text, or any error
 * notice of Cline's that isn't a poisoned history (resending the conversation can't hit the same rejection).
 */
export function isRetryableProviderError(error: FinalProviderError): boolean {
	return isTransientProviderError(error.text) || (error.notice && !isPoisonedHistoryError(error.text));
}

/** The provider unloaded the card's model for another one (Lemonade's "No model loaded: <model>"). */
export function isModelNotLoadedError(text: string): boolean {
	return MODEL_NOT_LOADED_PATTERN.test(text);
}

/** 0a3d1fc: the biggest tool result of the session, when it is big enough to have overflowed the context. */
export function findOverflowCulprit(
	messages: readonly ClineSessionDetailMessage[],
): { size: number; query: string | null } | null {
	let best: { size: number; query: string | null } | null = null;
	for (const message of messages) {
		for (const block of message.content) {
			if (block.type === "tool_result" && block.size !== undefined && (!best || block.size > best.size)) {
				best = { size: block.size, query: block.query ?? null };
			}
		}
	}
	return best && best.size > OVERFLOW_CULPRIT_MIN_BYTES ? best : null;
}

export interface HungRequest {
	sessionId: string;
	lastWriteAt: number;
	idleMin: number;
	/** No assistant reply yet: a provider that loads the model on the first request gets the longer limit. */
	firstCall: boolean;
}

/**
 * 0261b20: a model request that never returns. The TUI shows "Thinking… (esc to cancel)" for good, the session file
 * stays "running" and nothing is written, so no error path fires. Hung = the newest message is the user/tool-result
 * side (the model owes the reply) and nothing in the session dir moved for `hungMin` (`hungFirstMin` before the
 * first assistant reply when `slowFirstCall`, e.g. Lemonade loading the model). A long tool run (newest message =
 * the assistant's tool call) never counts.
 */
export function detectHungRequest(
	detail: ClineSessionDetail,
	options: { now: number; hungMin: number; hungFirstMin: number; slowFirstCall: boolean },
): HungRequest | null {
	if (detail.snapshot.status !== "running") {
		return null;
	}
	const last = detail.messages.at(-1);
	if (!last || last.role === "assistant") {
		return null;
	}
	const lastWriteAt = Math.max(detail.lastWriteAt ?? 0, detail.snapshot.messagesWrittenAt ?? 0, last.ts ?? 0);
	if (lastWriteAt <= 0) {
		return null;
	}
	const firstCall = options.slowFirstCall && !detail.messages.some((message) => message.role === "assistant");
	const idleMin = (options.now - lastWriteAt) / 60_000;
	return idleMin >= (firstCall ? options.hungFirstMin : options.hungMin)
		? { sessionId: detail.snapshot.sessionId, lastWriteAt, idleMin: Math.round(idleMin), firstCall }
		: null;
}

/** An agent run that ended on its own (or its provider's) error, not on its work. */
export type AgentRunError =
	| { kind: "image_rejected"; tooLarge: boolean; text: string }
	| { kind: "empty_reply"; text: string }
	/** The conversation outgrew the model's context: resending it overflows again (issue #26). */
	| { kind: "context_overflow"; text: string }
	| { kind: "provider_error"; text: string }
	| { kind: "session_failed"; text: string };

/**
 * Why a finished run's last turn is the agent's own failure, or null: an image rejection, an empty reply or a fatal
 * provider error poisons the conversation (every later request fails the same way), and a failed session file
 * ends the run. A QA card that ended like this never got to judge its dev card (issue #12: a QA card's last turns
 * were the 8000 px image error, and its "no verdict" STALLED took the dev card over).
 */
export function detectRunError(detail: ClineSessionDetail): AgentRunError | null {
	const premature = detectPrematureStop(detail.messages);
	if (premature?.kind === "no_images") {
		return { kind: "image_rejected", tooLarge: premature.tooLarge, text: premature.text };
	}
	if (premature?.kind === "empty") {
		return {
			kind: "empty_reply",
			text: premature.outputCap ? "empty model reply at the output cap" : "empty model reply",
		};
	}
	const error = detectFinalProviderError(detail.messages);
	if (error) {
		return {
			kind: isContextOverflowError(error.text) ? "context_overflow" : "provider_error",
			text: error.text.slice(0, 300),
		};
	}
	return detail.snapshot.status === "failed" ? { kind: "session_failed", text: "the Cline session failed" } : null;
}
