// The final message of an agent turn that has ended: the one reader of a summary's `finalMessage` for "what did the
// agent say at the end of its turn" (the orchestrator wait's closing question, the browser's spoken reply).
//
// The hook fields of a summary are merged (session-manager.ts applyHookActivity keeps a field the newest hook didn't
// send), so the final message counts only together with the hook event that sends it: the session is in Review because
// of a hook, and the latest hook is a turn end (Stop, TaskComplete, agentStop, ...) or has no event name. Any later
// hook (a tool, a prompt submit) means the message is a leftover of an older turn.
//
// Pure and dependency-free: the web-ui imports it as `@runtime-turn-final-message`.
import type { RuntimeTaskSessionSummary } from "./api-contract";

const TURN_END_HOOK_EVENTS = new Set(["stop", "taskcomplete", "agent_end", "afteragent", "agentstop"]);

export type TurnFinalMessageSession = Pick<RuntimeTaskSessionSummary, "state"> &
	Partial<Pick<RuntimeTaskSessionSummary, "reviewReason" | "latestHookActivity">>;

/** The hook event name ends a turn (or the hook sent none, as some adapters' turn-end hooks do). */
export function isTurnEndHookEvent(hookEventName: string | null | undefined): boolean {
	const event = hookEventName?.trim().toLowerCase() ?? "";
	return event === "" || TURN_END_HOOK_EVENTS.has(event);
}

/** The final message of the session's ended turn, or null when the turn hasn't ended or sent none. */
export function readTurnFinalMessage(session: TurnFinalMessageSession | null | undefined): string | null {
	if (!session || session.state !== "awaiting_review" || session.reviewReason !== "hook") {
		return null;
	}
	const activity = session.latestHookActivity;
	if (!isTurnEndHookEvent(activity?.hookEventName)) {
		return null;
	}
	const message = activity?.finalMessage?.trim() ?? "";
	return message.length > 0 ? message : null;
}
