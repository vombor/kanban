// The links an older worktree link rule left in live task worktrees (issue #19). New launches follow the rule in
// worktree-link-rule.ts, but a worktree created before it (or before a project changed
// `worktrees.symlinkIgnored`) still holds links the rule would not create now, such as `prisma/dev.db` or `.next`.
// Nothing removes those by itself: a running card may be using them. `kanban doctor` lists them per project, and the
// user's `kanban project unlink-ignored` replaces them, for cards with nothing running in their worktree, with what
// the rule gives a new card: a copy of the file (a database keeps its data, `checks.envFile` becomes the card's own)
// or an empty directory (a build output or cache is rebuilt).
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readlink, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getTaskWorktreeSearchRootPaths } from "../state/kanban-home";
import { runGit } from "./git-utils";
import { isPathWithinRoot } from "./path-sandbox";
import { readSymlinkedIgnoredPaths } from "./task-worktree";
import { decideIgnoredPathLink, type WorktreeLinkRule } from "./worktree-link-rule";

export interface StaleWorktreeLink {
	worktreePath: string;
	/** Relative to the worktree (and the project). */
	relativePath: string;
	/** The main checkout's path the link points to. */
	targetPath: string;
	/** What the rule gives a new card instead. */
	replacement: "copy" | "empty_dir" | "remove";
	reason: string;
}

async function realpathOrSelf(path: string): Promise<string> {
	return await realpath(path).catch(() => resolve(path));
}

/** The project's linked worktrees under Kanban's worktree roots (current and legacy), not the main checkout. */
export async function listKanbanTaskWorktrees(repoPath: string): Promise<string[]> {
	const list = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
	if (!list.ok) {
		return [];
	}
	const roots = await Promise.all(getTaskWorktreeSearchRootPaths().map((root) => realpathOrSelf(root)));
	const mainPath = await realpathOrSelf(repoPath);
	const worktrees: string[] = [];
	for (const line of list.stdout.split("\n")) {
		if (!line.startsWith("worktree ")) {
			continue;
		}
		const path = line.slice("worktree ".length).trim();
		const real = await realpathOrSelf(path);
		if (real === mainPath || !roots.some((root) => real !== root && isPathWithinRoot(root, real))) {
			continue;
		}
		if ((await stat(path).catch(() => null))?.isDirectory()) {
			worktrees.push(path);
		}
	}
	return worktrees;
}

/** Whether `linkPath` is a link Kanban made: a symlink to the same path in the main checkout. */
async function isKanbanLink(linkPath: string, targetPath: string): Promise<boolean> {
	if (!(await lstat(linkPath).catch(() => null))?.isSymbolicLink()) {
		return false;
	}
	const target = await readlink(linkPath).catch(() => null);
	if (target === null) {
		return false;
	}
	const absoluteTarget = isAbsolute(target) ? target : resolve(join(linkPath, ".."), target);
	return (
		absoluteTarget === targetPath || (await realpathOrSelf(absoluteTarget)) === (await realpathOrSelf(targetPath))
	);
}

/** The links in one worktree that the rule would not create now. */
export async function findStaleWorktreeLinks(options: {
	repoPath: string;
	worktreePath: string;
	rule: WorktreeLinkRule;
}): Promise<StaleWorktreeLink[]> {
	const stale: StaleWorktreeLink[] = [];
	for (const relativePath of await readSymlinkedIgnoredPaths(options.worktreePath)) {
		const decision = decideIgnoredPathLink(relativePath, options.rule);
		if (decision.action === "link") {
			continue;
		}
		const linkPath = join(options.worktreePath, relativePath);
		const targetPath = join(options.repoPath, relativePath);
		if (!(await isKanbanLink(linkPath, targetPath))) {
			continue;
		}
		const targetStat = await stat(targetPath).catch(() => null);
		stale.push({
			worktreePath: options.worktreePath,
			relativePath,
			targetPath,
			replacement: !targetStat ? "remove" : targetStat.isDirectory() ? "empty_dir" : "copy",
			reason: decision.action === "copy" ? "checks.envFile: each card gets its own copy" : decision.reason,
		});
	}
	return stale;
}

/** Replaces one stale link with what the rule gives a new card. Re-checks that it is still Kanban's link. */
export async function replaceStaleWorktreeLink(link: StaleWorktreeLink): Promise<string> {
	const linkPath = join(link.worktreePath, link.relativePath);
	if (!(await isKanbanLink(linkPath, link.targetPath))) {
		return `${linkPath}: no longer Kanban's link, left alone`;
	}
	await unlink(linkPath);
	if (link.replacement === "empty_dir") {
		await mkdir(linkPath, { recursive: true });
		return `${linkPath}: link replaced with an empty directory`;
	}
	if (link.replacement === "copy") {
		await copyFile(link.targetPath, linkPath, fsConstants.COPYFILE_EXCL);
		return `${linkPath}: link replaced with a copy of ${link.targetPath}`;
	}
	return `${linkPath}: dangling link removed`;
}
