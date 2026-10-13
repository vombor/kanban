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

/**
 * A provider's answer about the user's account rather than the model or the request: ClinePass's (cline 3.0.70's
 * texts and matchers in its bundle, checked 2026-10-12 with real TUI runs against a fake server, where Cline wrote each
 * as an error notice): `no_subscription` ("No access to ClinePass subscription models yet. Subscribe to ClinePass..."),
 * `organization_account` ("Organization accounts cannot use ClinePass subscriptions...") and `limit` ("You have
 * reached your ClinePass limit... Please try again later."). The first two last until the user changes the account,
 * so no retry, nudge or other model of the same account helps; a limit ends with its period.
 */
export type ProviderAccountErrorKind = "no_subscription" | "organization_account" | "limit";

const PROVIDER_ACCOUNT_ERROR_PATTERNS: ReadonlyArray<{ kind: ProviderAccountErrorKind; pattern: RegExp }> = [
	{
		kind: "no_subscription",
		pattern: /the user is not subscribed to required model plan|no access to clinepass subscription models yet/i,
	},
	{
		kind: "organization_account",
		pattern: /organization accounts cannot use (?:individual model inference subscriptions|clinepass subscriptions)/i,
	},
	{ kind: "limit", pattern: /you have reached your\b[\s\S]*?clinepass limit[\s\S]*?please try again later\./i },
];

export function getProviderAccountError(text: string): ProviderAccountErrorKind | null {
	return PROVIDER_ACCOUNT_ERROR_PATTERNS.find(({ pattern }) => pattern.test(text))?.kind ?? null;
}

const LIMIT_RESET_PATTERN =
	/\bresets in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i;
const LIMIT_RESET_PART_PATTERN = /(\d+)\s*([a-z]+)/gi;
const LIMIT_RESET_UNIT_MS: ReadonlyArray<{ pattern: RegExp; ms: number }> = [
	{ pattern: /^d(?:ays?)?$/, ms: 86_400_000 },
	{ pattern: /^h(?:ours?|rs?)?$/, ms: 3_600_000 },
	{ pattern: /^m(?:inutes?|ins?)?$/, ms: 60_000 },
	{ pattern: /^s(?:econds?|ecs?)?$/, ms: 1000 },
];
/** A reset further out than this is no period a hold should wait for (a misread). */
const LIMIT_RESET_MAX_MS = 8 * 86_400_000;

/**
 * When a provider usage limit ends, from its own text ("You have reached your 5-hour Clinepass limit. The limit resets
 * in 4h 13m, please try again later.", issue #49), counted from `seenAt` (when the provider said it). Null when the
 * text names no reset.
 */
export function readProviderLimitResetAt(text: string, seenAt: number): number | null {
	const match = LIMIT_RESET_PATTERN.exec(text);
	if (!match?.[1]) {
		return null;
	}
	let ms = 0;
	for (const part of match[1].matchAll(LIMIT_RESET_PART_PATTERN)) {
		const unit = LIMIT_RESET_UNIT_MS.find(({ pattern }) => pattern.test((part[2] ?? "").toLowerCase()));
		if (!unit) {
			return null;
		}
		ms += Number(part[1]) * unit.ms;
	}
	return ms > 0 && ms <= LIMIT_RESET_MAX_MS ? seenAt + ms : null;
}

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
