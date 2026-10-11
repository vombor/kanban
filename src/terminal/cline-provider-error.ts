// Whether a Cline CLI turn's final reply is an error, not the model's answer: a bare provider/transport error, a
// short fatal API error that poisons the conversation, or Cline's own error notice (`displayError`). The one reader
// of that question (AGENTS.md, Cline's error notices): recovery, the QA gate's run-error check and the vet probe ask
// it through src/pipeline/recovery-detect.ts, the turn detector (cline-turn-check.ts) here, so it lives below both.
// Pure: no I/O.
import { isKanbanClineHubAbortReason } from "./cline-hub-abort-reason";
import type { ClineSessionDetailMessage } from "./cline-session-files";
import {
	CLINE_CONTEXT_OVERFLOW_PATTERN,
	type ClineSessionMessage,
	getClineProviderErrorText,
} from "./cline-turn-outcome";

// An API error that stays in the conversation and fails every later request: "continue" can't help, only a new
// conversation (/clear) with the card prompt resent (c09cd4b: `ls -R` over node_modules overflowed a 131k context
// and "continue" re-sent it). Overflows include llama.cpp's (Lemonade) "Context size has been exceeded." and "the
// request exceeds the available context size" (CLINE_CONTEXT_OVERFLOW_PATTERN; issues #25, #26).
const OVERFLOW_PATTERN = new RegExp(
	`context length|context window|input length|prompt is too long|too many tokens|${CLINE_CONTEXT_OVERFLOW_PATTERN.source}`,
	"i",
);
const POISONED_PATTERN = new RegExp(
	`ValidationException|failed to satisfy constraint|validation error|invalid.*tool.?use|messages\\.\\d+|${OVERFLOW_PATTERN.source}`,
	"i",
);

/** A fatal API error shown as the whole final reply is at most this long (longer text is the agent talking). */
const FINAL_ERROR_MAX_LENGTH = 600;

export function isPoisonedHistoryError(text: string): boolean {
	return POISONED_PATTERN.test(text);
}

export function isContextOverflowError(text: string): boolean {
	return OVERFLOW_PATTERN.test(text);
}

export function hasClineToolUse(message: ClineSessionDetailMessage): boolean {
	return message.content.some((block) => block.type === "tool_use");
}

export function getClineMessageText(message: ClineSessionDetailMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join(" ")
		.trim();
}

/** A turn's final reply that is an error, not the model's answer. */
export interface FinalProviderError {
	text: string;
	/**
	 * Cline's own error notice in place of a reply (`displayError`): "No model loaded: <model>", llama.cpp's
	 * "decode() failed: vk::Queue::submit: ErrorDeviceLost", "Response stream ended without a finish reason.". Most
	 * match no text pattern (issues #25, #32).
	 */
	notice: boolean;
}

/**
 * 0bc6387: a final reply that is a bare provider error ("The operation timed out.") ends the turn on an error. So
 * does a short final reply carrying a fatal API error (context overflow, a Bedrock ValidationException), which the
 * legacy kit read from Cline's hooks log and Kanban only sees in the session file, and any error notice Cline wrote
 * in place of a reply (issue #32: a rework turn whose whole reply was "No model loaded: <model>" was escalated as
 * "came back unchanged"), except the reason of a run Kanban itself ended through the Cline hub (cline-hub-abort-reason.ts).
 */
export function detectFinalProviderError(messages: readonly ClineSessionDetailMessage[]): FinalProviderError | null {
	const last = messages.at(-1);
	if (!last || last.role !== "assistant" || hasClineToolUse(last)) {
		return null;
	}
	const text = getClineMessageText(last);
	const notice = Boolean(last.displayError);
	// Kanban's own `run.abort` reason, which Cline writes as a notice too (issue #28): Kanban ended that run.
	if (notice && isKanbanClineHubAbortReason(text)) {
		return null;
	}
	if (text.length <= FINAL_ERROR_MAX_LENGTH && isPoisonedHistoryError(text)) {
		return { text, notice };
	}
	const matched = getClineProviderErrorText(text);
	if (matched) {
		return { text: matched, notice };
	}
	return notice && text ? { text, notice } : null;
}

/** detectFinalProviderError on a session snapshot's last message (the turn detector's view, cline-turn-outcome.ts). */
export function detectFinalReplyProviderError(message: ClineSessionMessage | null): FinalProviderError | null {
	if (!message) {
		return null;
	}
	const content =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.map((block) => ({
					type: block.type,
					...(block.text === undefined ? {} : { text: block.text }),
				}));
	return detectFinalProviderError([
		{
			role: message.role,
			content,
			outputTokens: null,
			ts: null,
			...(message.displayError ? { displayError: true } : {}),
		},
	]);
}
