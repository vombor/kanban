// Doctor row: links in live task worktrees that the project's worktree link rule would not create now (issue #19,
// src/workspace/worktree-link-rule.ts): a shared database, build output or cache an older rule linked in. Read-only
// and never fixed by `--fix`: a running card may be using the link, so the row names the paths and the user runs
// `kanban project unlink-ignored`, which skips worktrees with a running process.
import type { PipelineConfig } from "../config/pipeline-config";
import { quoteShellArg } from "../core/shell";
import { type KitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import { findStaleWorktreeLinks, listKanbanTaskWorktrees } from "../workspace/worktree-link-audit";
import { buildWorktreeLinkRule } from "../workspace/worktree-link-rule";
import type { DoctorFinding } from "./doctor-report";

const MAX_LISTED_LINKS = 20;

export async function checkWorktreeLinks(context: {
	config: PipelineConfig;
	catalog: KitCatalog;
	entries: RuntimeWorkspaceIndexEntry[];
}): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	for (const entry of context.entries) {
		const rule = buildWorktreeLinkRule(resolveWorkspaceKit(context.config, entry.workspaceId, context.catalog).kit);
		const lines: string[] = [];
		let worktreeCount = 0;
		for (const worktreePath of await listKanbanTaskWorktrees(entry.repoPath)) {
			const stale = await findStaleWorktreeLinks({ repoPath: entry.repoPath, worktreePath, rule });
			if (stale.length > 0) {
				worktreeCount += 1;
			}
			lines.push(
				...stale.map((link) => `${worktreePath}/${link.relativePath} → ${link.targetPath} (${link.reason})`),
			);
		}
		if (lines.length === 0) {
			continue;
		}
		const listed = lines.slice(0, MAX_LISTED_LINKS);
		const more = lines.length > listed.length ? `; and ${lines.length - listed.length} more` : "";
		findings.push({
			level: "warn",
			area: "project",
			message: `${entry.workspaceId}: ${lines.length} link(s) to the main checkout in ${worktreeCount} task worktree(s) that the worktree link rule no longer creates, so those cards still share them: ${listed.join("; ")}${more}`,
			hint: `the user runs kanban project unlink-ignored ${quoteShellArg(entry.repoPath)} (copies files, empties directories; skips worktrees with a running process; --dry-run lists)`,
		});
	}
	if (findings.length === 0) {
		return [
			{
				level: "pass",
				area: "project",
				message: "no task worktree links a path the worktree link rule excludes",
			},
		];
	}
	return findings;
}
