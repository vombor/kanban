// Keeps a card's work in progress as a tag before recovery restarts its agent: a commit of the whole worktree
// (tracked and untracked files, minus .gitignore) built in a throwaway index, so the worktree and its own index are
// untouched. Restart recovery and `kanban task resume` tag `preserve/<id>-wip-<YYYYMMDDTHHMM>-restart` (a new tag
// per restart); `kanban task restart-fresh` tags `preserve/<id>-<label>` before it resets the worktree.
//
// Ported from archive/devteam-kit:lib/resume.mjs@6da71597 (tagWip, hasTrackedChanges) and
// archive/devteam-kit:tools/restart-fresh.mjs@6da71597 (step 1, preserve). The identity is fixed, not the user's
// gitconfig (e84c59e: a dangling ~/.gitconfig symlink broke every snapshot).
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "../workspace/git-utils";

export const KANBAN_GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "Kanban",
	GIT_AUTHOR_EMAIL: "kanban@localhost",
	GIT_COMMITTER_NAME: "Kanban",
	GIT_COMMITTER_EMAIL: "kanban@localhost",
} as const;

/** Whether the worktree has changes to tracked files (untracked files alone don't count, as in the legacy kit). */
export async function hasTrackedChanges(worktreePath: string): Promise<boolean> {
	const status = await runGit(worktreePath, ["status", "--short", "--untracked-files=no"]);
	return status.ok && status.stdout !== "";
}

function wipStamp(now: Date): string {
	return now.toISOString().slice(0, 16).replace(/[-:]/g, "");
}

async function tagExists(worktreePath: string, tag: string): Promise<boolean> {
	return (await runGit(worktreePath, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])).ok;
}

/** `preserve/<id>-wip-<stamp>-restart`, with `-2`, `-3`, … when that tag exists already. */
export async function nextRestartWipTag(worktreePath: string, taskId: string, now: Date): Promise<string> {
	const base = `preserve/${taskId}-wip-${wipStamp(now)}-restart`;
	let tag = base;
	for (let n = 2; await tagExists(worktreePath, tag); n += 1) {
		tag = `${base}-${n}`;
	}
	return tag;
}

/** Commits the whole worktree in a temporary index; returns the commit, or null when git refused. */
export async function commitWorktreeState(worktreePath: string, message: string): Promise<string | null> {
	const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
	if (!head.ok || !head.stdout) {
		return null;
	}
	const indexDir = await mkdtemp(join(tmpdir(), "kanban-wip-"));
	const indexFile = join(indexDir, "index");
	try {
		const realIndex = await runGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
		if (realIndex.ok && realIndex.stdout) {
			await copyFile(realIndex.stdout, indexFile).catch(() => {});
		}
		const env = createGitProcessEnv({ GIT_INDEX_FILE: indexFile, ...KANBAN_GIT_IDENTITY });
		if (!(await runGit(worktreePath, ["add", "-A"], { env })).ok) {
			return null;
		}
		const tree = await runGit(worktreePath, ["write-tree"], { env });
		if (!tree.ok || !tree.stdout) {
			return null;
		}
		const commit = await runGit(worktreePath, ["commit-tree", tree.stdout, "-p", head.stdout, "-m", message], {
			env: createGitProcessEnv(KANBAN_GIT_IDENTITY),
		});
		return commit.ok && commit.stdout ? commit.stdout : null;
	} finally {
		await rm(indexDir, { recursive: true, force: true });
	}
}

/** Tags the worktree state as `tag` (moving an existing tag only with `force`). Returns the tag, or null. */
export async function preserveWorktree(
	worktreePath: string,
	tag: string,
	message: string,
	options: { force?: boolean } = {},
): Promise<string | null> {
	const commit = await commitWorktreeState(worktreePath, message);
	if (!commit) {
		return null;
	}
	const args = options.force ? ["tag", "-f", tag, commit] : ["tag", tag, commit];
	return (await runGit(worktreePath, args)).ok ? tag : null;
}

/** The restart WIP tag for a card (a new one per restart), or null when the worktree could not be tagged. */
export async function tagRestartWip(
	worktreePath: string,
	taskId: string,
	now: Date = new Date(),
): Promise<string | null> {
	const tag = await nextRestartWipTag(worktreePath, taskId, now);
	return await preserveWorktree(
		worktreePath,
		tag,
		`WIP of ${taskId} at ${now.toISOString()} (Kanban restart recovery)`,
	);
}
