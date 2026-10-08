import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TerminalConnectionStatus } from "@/terminal/terminal-reconnect-controller";

// How long the terminal may show its loading state before it gives up and
// falls back to the plain terminal with the connection status and retry UI.
// Long enough for a slow agent CLI boot (Claude Code with MCP servers), short
// enough that a session nobody starts doesn't spin for good.
export const TERMINAL_LOADING_TIMEOUT_MS = 20_000;

// Why the terminal is not ready yet:
// - connecting: the stream socket is not open or this stream has not completed a restore.
// - starting: connected, the screen is empty and the session has no process yet
//   (after a restart, until the sidebar or recovery starts it again).
// - waiting_for_output: the session has a process that has printed nothing yet (agent CLI booting).
export type TerminalLoadingPhase = "connecting" | "starting" | "waiting_for_output";

export type TerminalReadiness =
	| { state: "loading"; phase: TerminalLoadingPhase }
	| { state: "ready" }
	// Loading gave up (timeout) or reconnecting did: the panel shows the terminal
	// as it is, and the connection status offers the retry.
	| { state: "unavailable"; reason: "timeout" | "disconnected" };

export interface TerminalReadinessInput {
	connectionStatus: TerminalConnectionStatus;
	// Stream socket open and a restore completed on this stream.
	streamRestored: boolean;
	// Anything is on screen: a non-empty restore or output since the last reset.
	hasScreenOutput: boolean;
	summary: RuntimeTaskSessionSummary | null;
	// Whoever shows this terminal starts its session when it has none (the sidebar
	// agent does). Otherwise an empty terminal without a process is just idle.
	expectsSessionStart: boolean;
	loadingTimedOut: boolean;
}

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings and two-byte escapes.
const TERMINAL_ESCAPE_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences.
	/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not visible text.
const VISIBLE_CHARACTER_PATTERN = /[^\s\u0000-\u001f\u007f]/u;

// Whether terminal output draws anything. An agent CLI's first bytes are often
// only probes (`ESC[?u`, `ESC[c`) and an alternate screen switch, which leave the
// screen as black as before.
export function hasVisibleTerminalText(text: string): boolean {
	return VISIBLE_CHARACTER_PATTERN.test(text.replace(TERMINAL_ESCAPE_PATTERN, ""));
}

export function hasLiveSessionProcess(summary: RuntimeTaskSessionSummary | null): boolean {
	return (
		summary !== null && summary.pid !== null && (summary.state === "running" || summary.state === "awaiting_review")
	);
}

export function resolveTerminalReadiness(input: TerminalReadinessInput): TerminalReadiness {
	if (input.connectionStatus.state === "disconnected") {
		return { state: "unavailable", reason: "disconnected" };
	}
	const loading = resolveLoadingPhase(input);
	if (loading === null) {
		return { state: "ready" };
	}
	if (input.loadingTimedOut) {
		return { state: "unavailable", reason: "timeout" };
	}
	return { state: "loading", phase: loading };
}

function resolveLoadingPhase(input: TerminalReadinessInput): TerminalLoadingPhase | null {
	if (!input.streamRestored) {
		return "connecting";
	}
	if (input.hasScreenOutput) {
		return null;
	}
	if (hasLiveSessionProcess(input.summary)) {
		return "waiting_for_output";
	}
	return input.expectsSessionStart ? "starting" : null;
}

export function isSameTerminalReadiness(left: TerminalReadiness, right: TerminalReadiness): boolean {
	if (left.state !== right.state) {
		return false;
	}
	if (left.state === "loading" && right.state === "loading") {
		return left.phase === right.phase;
	}
	if (left.state === "unavailable" && right.state === "unavailable") {
		return left.reason === right.reason;
	}
	return true;
}
