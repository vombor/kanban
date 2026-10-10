// Decides from a Cline CLI (cline 3.x) session file whether the agent's turn is over although Cline never fired
// its TaskComplete hook. Pure: the caller reads the session file (cline-session-files.ts) and passes the clock.
//
// Some providers end a turn without TaskComplete (Lemonade/lmstudio/llama.cpp: the session goes "idle" after the
// final reply), so the card sat In Progress with its summary "running" (ebe38 10/06). A turn is over when the
// newest session's last message is an assistant reply with no tool call, nothing was written for a while, and
// the reply is one of:
//   - a reply with a `STATUS:` line (the status-line rule asks every model to end a finished turn with one),
//   - a QA reviewer's final line "QA <id> round N: PASS|FAIL|STALLED, report in …" (QA ends with no STATUS line),
//   - a provider image rejection ("no images", or an image over its size limits) or a bare provider error (the
//     session file may even stay "running"),
//   - with `requireStatus: false`, any final reply (used to stop a running → in_progress bounce).
// The reply must be newer than the moment the session last turned "running"; a reply from before that only
// counts after BOUNCE_QUIET_MS with nothing written (a bounce back to running that no new message followed).
//
// Ported from archive/devteam-kit:services/kanban-column-sync.mjs@6da71597 (clineTurnEnded) and
// archive/devteam-kit:lib/cline-session.cjs@6da71597 (NO_IMAGES, providerErrorText),
// archive/devteam-kit:lib/cline-hooks.cjs@6da71597 (parseStatus).

/** Quiet time after a regular final reply (17ac0070: 20 s with nothing written). */
export const CLINE_TURN_END_QUIET_MS = 20_000;
/** Quiet time after a rejection, which can leave the session file "running" (922b5b8c: a2cbb sat 15 min). */
export const CLINE_TURN_END_REJECTED_QUIET_MS = 120_000;
/** Quiet time after a bounce back to running that no new message followed (9675b6ff: 10a60's PASS never landed). */
export const CLINE_TURN_END_BOUNCE_QUIET_MS = 300_000;

export interface ClineSessionContentBlock {
	type: string;
	text?: string;
}

export interface ClineSessionMessage {
	role: string;
	content: string | ClineSessionContentBlock[];
}

/** What the detector needs from one cline 3.x session dir (`<id>.json` + `<id>.messages.json`). */
export interface ClineSessionSnapshot {
	sessionId: string;
	/** `status` of `<id>.json`: "running", "idle", "completed", "failed", … */
	status: string | null;
	startedAt: number | null;
	/** mtime of `<id>.messages.json`: when Cline last wrote a message. */
	messagesWrittenAt: number | null;
	lastMessage: ClineSessionMessage | null;
}

export type ClineStatusKind = "DONE" | "BLOCKED" | "NEEDS_INPUT";

export interface ClineStatusLine {
	kind: ClineStatusKind;
	detail: string;
}

export type ClineQaVerdictKind = "PASS" | "FAIL" | "STALLED";

export type ClineTurnEndReason = "status_line" | "qa_final_line" | "no_images" | "provider_error" | "final_reply";

export type ClineTurnNotEndedReason =
	| "no_session"
	| "no_final_reply"
	| "session_running"
	| "no_status_line"
	| "not_quiet"
	| "reply_before_running";

export type ClineTurnEndDecision =
	| {
			ended: true;
			reason: ClineTurnEndReason;
			/** When the final reply was written (the messages file mtime). */
			replyAt: number;
			/** The reply is older than the last switch to running; it counted after BOUNCE_QUIET_MS. */
			afterBounce: boolean;
			statusLine: ClineStatusLine | null;
			text: string;
	  }
	| { ended: false; reason: ClineTurnNotEndedReason };

export interface ClineTurnEndInput {
	session: ClineSessionSnapshot | null;
	/** When the Kanban session last switched to "running" (or started). */
	runningSince: number | null;
	now: number;
	/** Default true: a dev reply needs a STATUS line (an announcement without a tool call is not an ending, 9496770). */
	requireStatus?: boolean;
}

// A provider's "no images" rejection, shown as the final assistant text after a text-only model opened a
// screenshot (kimi-k3 aa1fe, gpt-6.1-sol a2cbb 10/06). Every later request fails until /clear.
const NO_IMAGES_PATTERN =
	/(doesn't|does not|do not) support (the )?image|image (input|field)s? (is |are )?not supported/i;
// A request-size rejection of an image the model does accept: the image stays in history and poisons the
// conversation the same way (issue #12, foo QA ebeb2 10/09: a full-page screenshot over 8000 px, "messages.1.
// content.86.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels").
// Anthropic/Bedrock also say "image exceeds 5 MB maximum" and "... max allowed size for many-image requests: 2000
// pixels"; OpenAI-compatible servers say "image is too large".
const IMAGE_TOO_LARGE_PATTERN =
	/image dimensions? exceeds? (the )?max(imum)?|image (size |file )?exceeds? (the )?(\d+(\.\d+)? ?[KMG]i?B )?(max|limit)|image (is |was )?too (large|big)|image (size|dimensions?) (is |are )?(too large|over the limit)|exceeds? (the )?max(imum)? (allowed )?image (size|dimensions?|pixels)/i;

// A provider/transport error shown as the whole final assistant text (a2cbb 10/06 20:29Z: "The operation timed
// out.", session idle, no STATUS line, no hook event, so the card sat In Progress for 80 min).
// A context overflow from a local server (issue #26, notes c92da/9e059 2026-10-10: Cline's whole reply was "Context
// size has been exceeded." for llama.cpp's exceed_context_size_error, "the request exceeds the available context
// size"), which the cloud providers' wordings in recovery-detect.ts didn't cover.
export const CLINE_CONTEXT_OVERFLOW_PATTERN =
	/context size (has been |was |is )?exceeded|exceeds? the available context size|exceed_context_size/i;
const PROVIDER_ERROR_PATTERN = new RegExp(
	`operation timed out|stream timeout|request timeout|service (temporarily )?unavailable|temporarily unavailable|internal server error|bad gateway|gateway time-?out|overloaded|too many requests|throttl|ECONNRESET|ECONNREFUSED|connection ?refused|ETIMEDOUT|socket hang up|unable to connect|${CLINE_CONTEXT_OVERFLOW_PATTERN.source}`,
	"i",
);
const PROVIDER_ERROR_MAX_LENGTH = 300;

// The QA prompt's last instruction: reply with one line "QA <devId> round <n>: PASS|FAIL|STALLED, report in …".
const QA_FINAL_LINE_PATTERN = /^[*_`>\s]*QA\s+\S+\s+round\s+\d+\s*:\s*(PASS|FAIL|STALLED)\b/i;

function lastNonEmptyLine(text: string): string {
	return (
		text
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? ""
	);
}

/** The STATUS line of a reply's last line, also when it closes the last paragraph ("… untouched. STATUS: DONE"). */
export function parseClineStatusLine(text: string): ClineStatusLine | null {
	const match = /(?:^|[.!?)]\s+)[*_`>\s]*STATUS:\s*(DONE|BLOCKED|NEEDS_INPUT)\b\s*:?\s*(.*?)[*_`\s]*$/i.exec(
		lastNonEmptyLine(text),
	);
	if (!match?.[1]) {
		return null;
	}
	return { kind: match[1].toUpperCase() as ClineStatusKind, detail: (match[2] ?? "").trim() };
}

/**
 * Whether a reply carries a STATUS line anywhere at a line start, or closing its last paragraph inline
 * (e527b luna 10/06 20:12Z ended "... left untouched. STATUS: DONE" and sat In Progress 95 min).
 */
export function hasClineStatusLine(text: string): boolean {
	return /^\s*STATUS:\s*\S/m.test(text) || /\bSTATUS:\s*(DONE|BLOCKED|NEEDS_INPUT)\b[^\n]*$/i.test(text.trim());
}

export function parseClineQaFinalLine(text: string): ClineQaVerdictKind | null {
	const match = QA_FINAL_LINE_PATTERN.exec(lastNonEmptyLine(text));
	return match?.[1] ? (match[1].toUpperCase() as ClineQaVerdictKind) : null;
}

/** Why a provider rejected an image in the conversation: a text-only model, or an image over its size limits. */
export type ClineImageRejection = "unsupported" | "too_large";

export function getClineImageRejection(text: string): ClineImageRejection | null {
	if (NO_IMAGES_PATTERN.test(text)) {
		return "unsupported";
	}
	return IMAGE_TOO_LARGE_PATTERN.test(text) ? "too_large" : null;
}

/** Any image rejection (getClineImageRejection): the image stays in history and every later request fails. */
export function isClineNoImagesRejection(text: string): boolean {
	return getClineImageRejection(text) !== null;
}

/** The text when the whole reply is a short provider/transport error, else null. */
export function getClineProviderErrorText(text: string): string | null {
	const trimmed = text.trim();
	return trimmed && trimmed.length <= PROVIDER_ERROR_MAX_LENGTH && PROVIDER_ERROR_PATTERN.test(trimmed)
		? trimmed
		: null;
}

/** The text of an assistant message that made no tool call, else null. */
export function getClineFinalReplyText(message: ClineSessionMessage | null): string | null {
	if (message?.role !== "assistant") {
		return null;
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content) || message.content.some((block) => block.type === "tool_use")) {
		return null;
	}
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function classifyFinalReply(text: string, requireStatus: boolean): ClineTurnEndReason | null {
	if (isClineNoImagesRejection(text)) {
		return "no_images";
	}
	if (getClineProviderErrorText(text)) {
		return "provider_error";
	}
	if (hasClineStatusLine(text)) {
		return "status_line";
	}
	if (parseClineQaFinalLine(text)) {
		return "qa_final_line";
	}
	return requireStatus ? null : "final_reply";
}

export function evaluateClineTurnEnd(input: ClineTurnEndInput): ClineTurnEndDecision {
	const { session, now } = input;
	if (!session) {
		return { ended: false, reason: "no_session" };
	}
	if (session.status !== "idle" && session.status !== "running") {
		return { ended: false, reason: "session_running" };
	}
	const text = getClineFinalReplyText(session.lastMessage);
	if (text === null || session.messagesWrittenAt === null) {
		return { ended: false, reason: "no_final_reply" };
	}
	const reason = classifyFinalReply(text, input.requireStatus ?? true);
	const rejected = reason === "no_images" || reason === "provider_error";
	// A "running" session file only ends on a rejection: otherwise the model is still streaming.
	if (session.status === "running" && !rejected) {
		return { ended: false, reason: "session_running" };
	}
	if (reason === null) {
		return { ended: false, reason: "no_status_line" };
	}
	const quietMs = rejected ? CLINE_TURN_END_REJECTED_QUIET_MS : CLINE_TURN_END_QUIET_MS;
	if (now - session.messagesWrittenAt < quietMs) {
		return { ended: false, reason: "not_quiet" };
	}
	const runningSince = input.runningSince ?? 0;
	const afterBounce = session.messagesWrittenAt <= runningSince;
	// A reply from before the session turned running again (a rework typed seconds ago that Cline hasn't written
	// yet, or a bounce): only an ending once nothing was written for BOUNCE_QUIET_MS after that switch.
	if (afterBounce && now - runningSince < CLINE_TURN_END_BOUNCE_QUIET_MS) {
		return { ended: false, reason: "reply_before_running" };
	}
	return {
		ended: true,
		reason,
		replyAt: session.messagesWrittenAt,
		afterBounce,
		statusLine: parseClineStatusLine(text),
		text,
	};
}
