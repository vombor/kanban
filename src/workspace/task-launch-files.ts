// Files a card's agent launches write outside its worktree, keyed by task id. They go with the worktree:
// deleteTaskWorktree (src/workspace/task-worktree.ts) removes them, so Done, task delete and project removal all
// clean up, and a resumed card's launch writes them anew.
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { getRuntimeHomePath } from "../state/workspace-state";

function toSafeFileName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

/** A guarded Claude card's own --settings file (the shared settings.json is also the orchestrator's). */
export function getClaudeCardSettingsPath(taskId: string): string {
	return join(getRuntimeHomePath(), "hooks", "claude", "cards", `${toSafeFileName(taskId)}.json`);
}

/** Removes a card's launch files (a guarded Claude card's --settings file, which embeds the card's guard policy). */
export async function removeTaskLaunchFiles(taskId: string): Promise<void> {
	await rm(getClaudeCardSettingsPath(taskId), { force: true });
}
