// Doctor row: files an unclean stop of the pod can leave damaged (issue #36: notes' pipeline-state.json and card
// 45610's git index came back 0 bytes after the stop of 2026-10-11 ~17:14Z). Read-only: the pipeline replaces a
// damaged state file on its next write and restart recovery rebuilds an orphan's index after its WIP tag, so the row
// only says where that hasn't happened yet. An index is never rebuilt by `--fix`: a running card may be using it.
import { readFile } from "node:fs/promises";

import { quoteShellArg } from "../core/shell";
import { describeDamagedStateText } from "../pipeline/pipeline-state";
import { getPipelineStatePath } from "../state/kanban-home";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import { findUnreadableWorktreeIndex } from "../workspace/worktree-index-health";
import { listKanbanTaskWorktrees } from "../workspace/worktree-link-audit";
import type { DoctorFinding } from "./doctor-report";

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

export async function checkUncleanStopDamage(
	entries: RuntimeWorkspaceIndexEntry[],
	options: { getStatePath?: (workspaceId: string) => string } = {},
): Promise<DoctorFinding[]> {
	const getStatePath = options.getStatePath ?? ((workspaceId: string) => getPipelineStatePath(workspaceId));
	const findings: DoctorFinding[] = [];
	for (const entry of entries) {
		const statePath = getStatePath(entry.workspaceId);
		const text = await readTextOrNull(statePath);
		const damaged = text === null ? null : describeDamagedStateText(text);
		if (damaged) {
			findings.push({
				level: "warn",
				area: "project",
				message: `${entry.workspaceId}: ${statePath} is ${damaged}, probably left by an unclean stop; the pipeline reads it as no state and starts a new one on its next write (card history from before is gone)`,
			});
		}
		for (const worktreePath of [entry.repoPath, ...(await listKanbanTaskWorktrees(entry.repoPath))]) {
			const unreadable = await findUnreadableWorktreeIndex(worktreePath);
			if (!unreadable) {
				continue;
			}
			findings.push({
				level: "warn",
				area: "project",
				message: `${entry.workspaceId}: git can't read the index of ${worktreePath} (${unreadable.error}), so every git command there fails`,
				hint: `for an In Progress card, kanban task resume <id> tags its work and rebuilds the index; otherwise git -C ${quoteShellArg(worktreePath)} read-tree HEAD (the files are untouched; staged-only changes become unstaged)`,
			});
		}
	}
	if (findings.length === 0) {
		return [
			{
				level: "pass",
				area: "project",
				message: "no pipeline state file or git index left damaged by an unclean stop",
			},
		];
	}
	return findings;
}
