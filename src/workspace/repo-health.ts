// Why git doesn't see a work tree in a project directory that still has its `.git`. On 2026-10-07 tests run by a git
// hook set core.bare=true in a project's config; `git rev-parse --is-inside-work-tree` then said "false" and Kanban
// dropped the project and deleted its board as "not a git repository". A `.git` that git can't use is a broken repo
// to report (the stream resolver and `kanban doctor`), never a removed project.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";

export interface BrokenGitRepository {
	/** What is wrong, e.g. "its git config says core.bare=true but its working tree is still there". */
	problem: string;
	/** How to repair it. */
	hint: string;
}

function readGitOutput(repoPath: string, args: string[]): string | null {
	const result = spawnSync("git", args, {
		cwd: repoPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	return result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : null;
}

export function hasGitRepository(path: string): boolean {
	return readGitOutput(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * For a directory where git sees no work tree: why, when the directory still has a `.git` (a broken repo, whose board
 * must be kept), or null when it has none (it really is no git repository any more).
 */
export function describeBrokenGitRepository(repoPath: string): BrokenGitRepository | null {
	if (!existsSync(join(repoPath, ".git"))) {
		return null;
	}
	if (readGitOutput(repoPath, ["rev-parse", "--is-bare-repository"]) === "true") {
		return {
			problem: "its git config says core.bare=true but its working tree is still there",
			hint: `git -C ${repoPath} config core.bare false`,
		};
	}
	return {
		problem: "it has a .git that git can't read as a work tree",
		hint: `git -C ${repoPath} status`,
	};
}
