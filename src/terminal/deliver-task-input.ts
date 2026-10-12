// Types text into a task's agent TUI and confirms the agent picked it up.
//
// A raw PTY write says nothing about whether the TUI accepted the input: a
// TUI that is still rendering, unfocused (Copilot) or showing a prompt can
// drop the Enter. This is the one place that delivers typed input (the
// auto-review prompt today; rework, nudges and `kanban task send` later), so
// every caller gets the same choreography and a typed result:
//
//   focus-in (per agent) → text with newlines flattened → pause → Enter →
//   wait for session activity → if none, Enter once more → wait again.
//
// Activity means the session summary moved after Enter: a state change, a
// hook event or new output. Typing echoes before the mark is taken, so the
// echo of the text itself does not count as delivery.
//
// Nothing is typed while the user is typing in that terminal
// (TerminalSessionManager.hasTypedInputSinceEnter, the one "is the user typing"
// rule): Kanban's text and Enter would submit their half-written draft with it
// (issue #35). The answer is then `user_typing` with nothing written; Kanban's
// own deliveries that must still arrive (watchdog wakes, pipeline nudges and
// reworks) go through the typed-input hold (src/server/typed-input-hold.ts),
// which types them once the user's input clears.

import type {
	RuntimeAgentId,
	RuntimeTaskInputDeliveryEvidence,
	RuntimeTaskInputDeliveryResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTypedInput,
} from "../core/api-contract";
import { getAgentInputDeliveryProfile } from "./agent-session-adapters";

const FOCUS_IN = "\u001b[I";
const ENTER = "\r";

/** Pause between the text and Enter so the TUI has processed the text (the browser uses the same). */
const DEFAULT_SUBMIT_DELAY_MS = 200;
/** How long one Enter gets to show activity before it is retried. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_ENTER_ATTEMPTS = 2;

export const USER_TYPING_ERROR = "The user is typing in this terminal; nothing was typed.";

function formatAgo(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 120) {
		return `${seconds} s ago`;
	}
	const minutes = Math.round(seconds / 60);
	return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** Why the user counts as typing, for a person or the orchestrator: "a draft since <time>" or "a keystroke <n> s ago". */
export function describeTypedInputState(typing: RuntimeTaskTypedInput, now: number = Date.now()): string {
	if (typing.draftSince !== null) {
		const lastText = typing.draftTypedAt ?? typing.draftSince;
		return `a draft in the input box since ${new Date(typing.draftSince).toISOString()} (text last typed ${formatAgo(now - lastText)})`;
	}
	return typing.viewerTypedAt === null ? "a recent keystroke" : `a keystroke ${formatAgo(now - typing.viewerTypedAt)}`;
}

/** The slice of the terminal session manager delivery needs. */
export interface TaskInputTerminal {
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null;
	hasTypedInputSinceEnter(taskId: string): boolean;
	/** Why hasTypedInputSinceEnter holds, for the `user_typing` answer (absent: no reason given). */
	describeTypedInput?(taskId: string): RuntimeTaskTypedInput | null;
}

export interface DeliverTaskInputOptions {
	/** Press Enter after the text. Default true. */
	enter?: boolean;
	/** Wait for session activity after Enter and retry Enter once. Default true; ignored without `enter`. */
	confirm?: boolean;
	/** Agent to assume for the per-agent input profile when the session summary does not record one. */
	agentId?: RuntimeAgentId | null;
	signal?: AbortSignal;
	submitDelayMs?: number;
	confirmTimeoutMs?: number;
	pollIntervalMs?: number;
}

export type DeliverTaskInputResult = RuntimeTaskInputDeliveryResponse;

interface ActivityMark {
	state: RuntimeTaskSessionSummary["state"];
	lastHookAt: number | null;
	lastOutputAt: number | null;
}

/** TUIs submit on a bare newline, so multi-line text would be sent as several messages. */
export function flattenTaskInputText(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ");
}

// The process exit transition clears `pid`; a hydrated summary can keep a stale pid, so the first
// write (which fails without a live PTY) is what decides whether there is a session at all.
function hasEnded(summary: RuntimeTaskSessionSummary): boolean {
	return summary.pid === null;
}

function markOf(summary: RuntimeTaskSessionSummary): ActivityMark {
	return {
		state: summary.state,
		lastHookAt: summary.lastHookAt ?? null,
		lastOutputAt: summary.lastOutputAt ?? null,
	};
}

function evidenceSince(
	before: ActivityMark,
	summary: RuntimeTaskSessionSummary,
): RuntimeTaskInputDeliveryEvidence | null {
	if (summary.state !== before.state) {
		return "state";
	}
	if ((summary.lastHookAt ?? null) !== before.lastHookAt) {
		return "hook";
	}
	if ((summary.lastOutputAt ?? null) !== before.lastOutputAt) {
		return "output";
	}
	return null;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function result(
	status: DeliverTaskInputResult["status"],
	fields: Partial<Omit<DeliverTaskInputResult, "ok" | "status">> = {},
): DeliverTaskInputResult {
	return {
		ok: status === "delivered" || status === "sent",
		status,
		evidence: fields.evidence ?? null,
		enterAttempts: fields.enterAttempts ?? 0,
		summary: fields.summary ?? null,
		...(fields.error ? { error: fields.error } : {}),
		...(fields.typing ? { typing: fields.typing } : {}),
	};
}

export async function deliverTaskInput(
	terminal: TaskInputTerminal,
	taskId: string,
	text: string,
	options: DeliverTaskInputOptions = {},
): Promise<DeliverTaskInputResult> {
	const enter = options.enter ?? true;
	const confirm = enter && (options.confirm ?? true);
	const submitDelayMs = options.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS;
	const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const { signal } = options;

	const write = (data: string): RuntimeTaskSessionSummary | null => {
		try {
			return terminal.writeInput(taskId, Buffer.from(data, "utf8"));
		} catch {
			return null;
		}
	};

	const initial = terminal.getSummary(taskId);
	if (!initial) {
		return result("no_session", { error: "Task session is not running." });
	}
	if (terminal.hasTypedInputSinceEnter(taskId)) {
		const typing = terminal.describeTypedInput?.(taskId) ?? null;
		return result("user_typing", {
			summary: initial,
			error: typing
				? `The user is typing in this terminal (${describeTypedInputState(typing)}); nothing was typed.`
				: USER_TYPING_ERROR,
			...(typing ? { typing } : {}),
		});
	}

	// Text and focus-in are written before the first await, so a caller that
	// does not await still has the text in the PTY when this returns.
	const profile = getAgentInputDeliveryProfile(initial.agentId ?? options.agentId ?? null);
	if (profile.focusInBeforeInput && !write(FOCUS_IN)) {
		return result("no_session", { summary: terminal.getSummary(taskId), error: "Task session is not running." });
	}
	const payload = flattenTaskInputText(text);
	let latest: RuntimeTaskSessionSummary | null = initial;
	if (payload.length > 0) {
		latest = write(payload);
		if (!latest) {
			return result("no_session", { summary: terminal.getSummary(taskId), error: "Task session is not running." });
		}
	}
	if (!enter) {
		return result("sent", { summary: latest });
	}

	await sleep(submitDelayMs, signal);
	if (signal?.aborted) {
		return result("aborted", { summary: terminal.getSummary(taskId), error: "Delivery was cancelled." });
	}

	const beforeEnter = terminal.getSummary(taskId);
	if (!beforeEnter || hasEnded(beforeEnter)) {
		return result("session_ended", { summary: beforeEnter, error: "Task session ended before Enter." });
	}
	const mark = markOf(beforeEnter);

	for (let attempt = 1; attempt <= MAX_ENTER_ATTEMPTS; attempt += 1) {
		const afterEnter = write(ENTER);
		if (!afterEnter) {
			return result("session_ended", {
				enterAttempts: attempt - 1,
				summary: terminal.getSummary(taskId),
				error: "Task session ended before Enter.",
			});
		}
		if (!confirm) {
			return result("sent", { enterAttempts: attempt, summary: afterEnter });
		}
		for (const deadline = Date.now() + confirmTimeoutMs; Date.now() < deadline; ) {
			await sleep(pollIntervalMs, signal);
			if (signal?.aborted) {
				return result("aborted", {
					enterAttempts: attempt,
					summary: terminal.getSummary(taskId),
					error: "Delivery was cancelled.",
				});
			}
			const current = terminal.getSummary(taskId);
			if (!current || hasEnded(current)) {
				return result("session_ended", {
					enterAttempts: attempt,
					summary: current,
					error: "Task session ended while waiting for the agent to pick up the input.",
				});
			}
			const evidence = evidenceSince(mark, current);
			if (evidence) {
				return result("delivered", { evidence, enterAttempts: attempt, summary: current });
			}
		}
	}

	return result("undelivered", {
		enterAttempts: MAX_ENTER_ATTEMPTS,
		summary: terminal.getSummary(taskId),
		error: "Typed input not picked up (no session activity after Enter, twice).",
	});
}
