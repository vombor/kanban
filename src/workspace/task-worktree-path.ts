// Shared with web-ui, so it must not touch node APIs. The worktrees root comes from the runtime
// (src/state/kanban-home.ts on the server, the runtime config response in the browser).
const WORKTREE_TASK_ID_INVALID_MESSAGE = "Invalid task id for worktree path.";

export function normalizeTaskIdForWorktreePath(taskId: string): string {
	const normalized = taskId.trim();
	if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
		throw new Error(WORKTREE_TASK_ID_INVALID_MESSAGE);
	}
	return normalized;
}

export function getWorkspaceFolderLabelForWorktreePath(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folder =
		trimmed
			.split(/[\\/]/g)
			.filter((segment) => segment.length > 0)
			.at(-1) ?? "workspace";
	const cleaned = [...folder]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("")
		.trim();
	return cleaned || "workspace";
}

export function buildTaskWorktreeDisplayPath(taskId: string, repoPath: string, worktreesRootPath: string): string {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	const workspaceLabel = getWorkspaceFolderLabelForWorktreePath(repoPath);
	const root = worktreesRootPath.replace(/[\\/]+$/g, "");
	return `${root}/${normalizedTaskId}/${workspaceLabel}`;
}
