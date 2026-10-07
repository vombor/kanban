// Each task card can own a second, user-opened shell terminal in the detail
// view. It runs under a synthetic session id derived from the task id, so the
// runtime can stop it together with the task when the card moves to Done.
const DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";

export function getDetailTerminalTaskId(taskId: string): string {
	return `${DETAIL_TERMINAL_TASK_PREFIX}${taskId}`;
}
