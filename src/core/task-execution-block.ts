import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "./api-contract";

export const TASK_EXECUTION_BLOCK_EVENT = "KanbanGuardRefusal";
export const TASK_EXECUTION_BLOCK_PREFIX = "Kanban execution blocked: ";
export function isTaskExecutionBlockWarning(message: string | null | undefined): boolean {
	return message?.startsWith(TASK_EXECUTION_BLOCK_PREFIX) ?? false;
}
/** Read the complete current marker, never a notification field left over from an older merged hook. */
export function readTaskExecutionBlock(activity: Partial<RuntimeTaskHookActivity> | null | undefined): string | null {
	return activity?.source === "cline-guard" &&
		activity.hookEventName === TASK_EXECUTION_BLOCK_EVENT &&
		activity.notificationType === "execution_blocked"
		? activity.activityText || "Kanban guardrails refused this tool; the turn is incomplete and needs user attention."
		: null;
}

export function isTaskExecutionBlocked(
	session:
		| Partial<Pick<RuntimeTaskSessionSummary, "state" | "latestHookActivity" | "warningMessage">>
		| null
		| undefined,
): boolean {
	return (
		session?.state === "awaiting_review" &&
		(isTaskExecutionBlockWarning(session.warningMessage) ||
			readTaskExecutionBlock(session.latestHookActivity) !== null)
	);
}
