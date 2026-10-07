// Snapshots (plan §2.6): a commit of a task worktree's current state at `refs/kanban/snapshots/<taskId>`, taken
// when a card is submitted. The snapshot is what QA reviews, what the checks run on and what lands, so later edits in
// the worktree can't slip past the gate unseen. Taking one never touches the worktree's own index, HEAD or files.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (snapshotWorktree, recordSnapshot,
// snapshotIsEmpty) and @e84c59e9 (a fixed identity for snapshot commits).
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "../workspace/git-utils";

/**
 * Snapshot commits are internal refs, so they use a fixed identity and never depend on the user's gitconfig: a
 * dangling `~/.gitconfig` symlink (03:19Z 10/06) made every legacy snapshot fail.
 */
export const SNAPSHOT_GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "Kanban",
	GIT_AUTHOR_EMAIL: "kanban@localhost",
	GIT_COMMITTER_NAME: "Kanban",
	GIT_COMMITTER_EMAIL: "kanban@localhost",
} as const;

export function getSnapshotRef(taskId: string): string {
	return `refs/kanban/snapshots/${taskId}`;
}

export interface TaskSnapshot {
	commit: string;
	/** The worktree HEAD the snapshot sits on. */
	parent: string;
	/** The snapshot ref before this one, or null. */
	previous: string | null;
	/** False when the worktree matched the previous snapshot's tree (the previous commit is reused). */
	changed: boolean;
	/** Whether the snapshot differs from its merge-base with the card's base: false = nothing to submit. */
	hasChanges: boolean;
	/** False in a dry run (shadow): the commit exists, the ref was not moved. */
	recorded: boolean;
}

export interface TakeTaskSnapshotInput {
	/** The task's worktree. */
	worktreePath: string;
	taskId: string;
	baseRef: string;
	/** Why it was taken, for the commit message and the ref's reflog (`review`, `pre-land`, …). */
	reason: string;
	/** Shadow: build the commit but leave the ref alone. */
	dryRun: boolean;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
	const result = await runGit(cwd, args, { env: createGitProcessEnv(env) });
	if (!result.ok) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout || result.error}`);
	}
	return result.stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
	const result = await runGit(cwd, args, { env: createGitProcessEnv() });
	return result.ok ? result.stdout : null;
}

export async function readTaskSnapshot(cwd: string, taskId: string): Promise<string | null> {
	return (await tryGit(cwd, ["rev-parse", "-q", "--verify", `${getSnapshotRef(taskId)}^{commit}`])) || null;
}

/**
 * Does the snapshot change anything against its merge-base with the base? A snapshot that equals its base is a
 * card whose agent never really ran, and QA on it is wasted work. A base that can't be resolved counts as "has
 * changes": the gate must not drop a card because of a missing ref.
 */
export async function snapshotHasChanges(cwd: string, snapshot: string, baseRef: string): Promise<boolean> {
	const mergeBase = await tryGit(cwd, ["merge-base", snapshot, baseRef || "HEAD"]);
	if (!mergeBase) {
		return true;
	}
	const diff = await runGit(cwd, ["diff", "--quiet", mergeBase, snapshot], { env: createGitProcessEnv() });
	return !diff.ok;
}

/**
 * Commits the worktree's tracked and untracked files (honouring .gitignore) through a throwaway index, so the
 * agent's index and HEAD are untouched, and points `refs/kanban/snapshots/<taskId>` at it. When the tree equals
 * the previous snapshot's, the previous commit is kept (one snapshot per distinct state).
 */
export async function takeTaskSnapshot(input: TakeTaskSnapshotInput): Promise<TaskSnapshot> {
	const { worktreePath: cwd, taskId } = input;
	const tempIndex = join(tmpdir(), `kanban-snapshot-${taskId}-${process.pid}-${randomUUID()}.index`);
	try {
		const indexEnv = { GIT_INDEX_FILE: tempIndex };
		const parent = await git(cwd, ["rev-parse", "HEAD"]);
		await git(cwd, ["read-tree", "HEAD"], indexEnv);
		await git(cwd, ["add", "-A"], indexEnv);
		const tree = await git(cwd, ["write-tree"], indexEnv);
		const previous = await readTaskSnapshot(cwd, taskId);
		let commit: string;
		let changed = true;
		if (previous && (await tryGit(cwd, ["rev-parse", `${previous}^{tree}`])) === tree) {
			commit = previous;
			changed = false;
		} else {
			commit = await git(
				cwd,
				["commit-tree", tree, "-p", parent, "-m", `kanban snapshot ${taskId} (${input.reason})`],
				SNAPSHOT_GIT_IDENTITY,
			);
		}
		let recorded = false;
		if (changed && !input.dryRun) {
			await git(cwd, [
				"update-ref",
				"--create-reflog",
				"-m",
				`kanban pipeline: ${input.reason}`,
				getSnapshotRef(taskId),
				commit,
			]);
			recorded = true;
		}
		return {
			commit,
			parent,
			previous,
			changed,
			hasChanges: await snapshotHasChanges(cwd, commit, input.baseRef),
			recorded: recorded || !changed,
		};
	} finally {
		await rm(tempIndex, { force: true });
	}
}
