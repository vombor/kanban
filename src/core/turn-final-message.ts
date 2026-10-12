// The final message of an agent turn that has ended: the one reader of "what did the agent say at the end of its
// turn" (the orchestrator wait's closing question, the browser's spoken reply).
//
// The hook fields of a summary are merged (session-manager.ts applyHookActivity keeps a field the newest hook didn't
// send), and the newest event name is often not the turn end's: Claude Code sends an idle Notification right after
// Stop, and Codex's turn ends are agent_message/task_complete. So the turn end is its own record, `lastTurnEnd`: the
// final message of the `to_review` hook that moved the session to Review, kept through later hooks of that Review and
// cleared on every state change (a prompt submit, a tool's PostToolUse, the process exit). It counts only while the
// session is in Review because of a hook.
//
// Pure and dependency-free: the web-ui imports it as `@runtime-turn-final-message`.
import type { RuntimeTaskSessionSummary, RuntimeTaskTurnEnd } from "./api-contract";

export type TurnFinalMessageSession = Pick<RuntimeTaskSessionSummary, "state"> &
	Partial<Pick<RuntimeTaskSessionSummary, "reviewReason" | "lastTurnEnd">>;

/** The session's ended turn (its final message and when it ended), or null while no turn end holds. */
export function readTurnEnd(session: TurnFinalMessageSession | null | undefined): RuntimeTaskTurnEnd | null {
	if (!session || session.state !== "awaiting_review" || session.reviewReason !== "hook") {
		return null;
	}
	const turnEnd = session.lastTurnEnd;
	const finalMessage = turnEnd?.finalMessage.trim() ?? "";
	return turnEnd && finalMessage.length > 0 ? { at: turnEnd.at, finalMessage } : null;
}

/** The final message of the session's ended turn, or null when the turn hasn't ended or sent none. */
export function readTurnFinalMessage(session: TurnFinalMessageSession | null | undefined): string | null {
	return readTurnEnd(session)?.finalMessage ?? null;
}
