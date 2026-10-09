// `kanban project unlink-ignored`: the user's way to replace the links an older worktree link rule left in a
// project's live task worktrees (issue #19, src/workspace/worktree-link-audit.ts). A worktree with any process inside
// it (the card's agent, a dev server it started, a test run) is skipped: its card may be using the link right now.
import { expandPathVariants, isProcessInPaths } from "../server/process-reaper";
import type { ProcessEntry } from "../server/process-table";
import {
	findStaleWorktreeLinks,
	listKanbanTaskWorktrees,
	replaceStaleWorktreeLink,
	type StaleWorktreeLink,
} from "../workspace/worktree-link-audit";
import type { WorktreeLinkRule } from "../workspace/worktree-link-rule";

export interface UnlinkIgnoredWorktreeResult {
	worktreePath: string;
	links: StaleWorktreeLink[];
	status: "replaced" | "would_replace" | "skipped";
	/** Why it was skipped. */
	detail?: string;
	actions: string[];
}

export interface UnlinkIgnoredOptions {
	repoPath: string;
	rule: WorktreeLinkRule;
	dryRun: boolean;
	/** The process table, or null where it can't be read: then every worktree with stale links is skipped. */
	listProcesses: (() => Promise<ProcessEntry[]>) | null;
	/** This command's pid: it and its ancestors (the user's shell may sit in a worktree) don't count as running. */
	selfPid: number;
}

function collectSelfAndAncestors(entries: readonly ProcessEntry[], selfPid: number): Set<number> {
	const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
	const pids = new Set<number>();
	let pid: number | undefined = selfPid;
	while (pid !== undefined && pid > 0 && !pids.has(pid)) {
		pids.add(pid);
		pid = byPid.get(pid)?.ppid;
	}
	return pids;
}

function describeRunning(entries: readonly ProcessEntry[], worktreePath: string, ignored: Set<number>): string | null {
	const paths = expandPathVariants([worktreePath]);
	const running = entries.filter(
		(entry) => !ignored.has(entry.pid) && entry.state !== "Z" && isProcessInPaths(entry, paths),
	);
	if (running.length === 0) {
		return null;
	}
	const first = running[0] as ProcessEntry;
	return `${running.length} process(es) running in it (pid ${first.pid}: ${first.command})`;
}

export async function runProjectUnlinkIgnored(options: UnlinkIgnoredOptions): Promise<UnlinkIgnoredWorktreeResult[]> {
	const results: UnlinkIgnoredWorktreeResult[] = [];
	for (const worktreePath of await listKanbanTaskWorktrees(options.repoPath)) {
		const links = await findStaleWorktreeLinks({ repoPath: options.repoPath, worktreePath, rule: options.rule });
		if (links.length === 0) {
			continue;
		}
		if (options.dryRun) {
			results.push({ worktreePath, links, status: "would_replace", actions: [] });
			continue;
		}
		if (!options.listProcesses) {
			results.push({
				worktreePath,
				links,
				status: "skipped",
				detail: "can't read the process table here, so can't tell whether its card is running",
				actions: [],
			});
			continue;
		}
		// Read per worktree: replacing one worktree's links takes long enough for a card to start meanwhile.
		const entries = await options.listProcesses();
		const running = describeRunning(entries, worktreePath, collectSelfAndAncestors(entries, options.selfPid));
		if (running) {
			results.push({ worktreePath, links, status: "skipped", detail: running, actions: [] });
			continue;
		}
		const actions: string[] = [];
		for (const link of links) {
			actions.push(await replaceStaleWorktreeLink(link));
		}
		results.push({ worktreePath, links, status: "replaced", actions });
	}
	return results;
}

export function formatUnlinkIgnoredResults(results: readonly UnlinkIgnoredWorktreeResult[]): string[] {
	if (results.length === 0) {
		return ["No task worktree links a path the worktree link rule excludes."];
	}
	const lines: string[] = [];
	for (const result of results) {
		if (result.status === "would_replace") {
			lines.push(`${result.worktreePath}: would replace ${result.links.length} link(s)`);
			for (const link of result.links) {
				lines.push(
					`  ${link.relativePath} → ${link.targetPath}: ${link.replacement === "empty_dir" ? "empty directory" : link.replacement === "copy" ? "copy" : "remove (dangling)"} (${link.reason})`,
				);
			}
		} else if (result.status === "skipped") {
			lines.push(`${result.worktreePath}: skipped, ${result.detail}; run it again once the card is idle`);
		} else {
			lines.push(`${result.worktreePath}:`, ...result.actions.map((action) => `  ${action}`));
		}
	}
	return lines;
}
