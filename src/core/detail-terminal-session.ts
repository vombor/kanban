// Each task card can own a second, user-opened shell terminal in the detail
// view. It runs under a synthetic session id derived from the task id, so the
// runtime can stop it together with the task when the card moves to Done.
const DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";

export function getDetailTerminalTaskId(taskId: string): string {
	return `${DETAIL_TERMINAL_TASK_PREFIX}${taskId}`;
}

export function isDetailTerminalTaskId(sessionId: string): boolean {
	return sessionId.startsWith(DETAIL_TERMINAL_TASK_PREFIX);
}

/** The card a detail terminal belongs to, or null for any other session id. */
export function getTaskIdOfDetailTerminal(sessionId: string): string | null {
	return isDetailTerminalTaskId(sessionId) ? sessionId.slice(DETAIL_TERMINAL_TASK_PREFIX.length) : null;
}
