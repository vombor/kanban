// A worktree whose git index git can't read. Git writes the index with a lock file and a rename but without an fsync
// by default, so an unclean stop of the pod can leave it 0 bytes (2026-10-11 ~17:14Z, issue #36):
// every git command in that worktree then fails ("index file smaller than expected"), the agent's included. The
// working tree is untouched, so the index can be rebuilt from HEAD (`git read-tree HEAD`, which never reads the old
// index); what was only staged becomes unstaged or untracked again, nothing on disk is lost.
import { rename } from "node:fs/promises";

import { runGit } from "./git-utils";

/** Git's own words for an index it can't read (read-cache.c). */
const UNREADABLE_INDEX_PATTERN =
	/index file smaller than expected|bad signature 0x[0-9a-f]+|bad index (?:file sha1 signature|version)|index file corrupt|unknown index entry format|index uses \S+ extension, which we do not understand/iu;

export interface UnreadableWorktreeIndex {
	indexPath: string;
	/** Git's error. */
	error: string;
}

/** Whether a failed git command's output says the index can't be read. */
export function isUnreadableIndexError(output: string): boolean {
	return UNREADABLE_INDEX_PATTERN.test(output);
}

/** The worktree's index when git can't read it, or null (readable, or not a git worktree at all). */
export async function findUnreadableWorktreeIndex(worktreePath: string): Promise<UnreadableWorktreeIndex | null> {
	// --no-optional-locks: a check never rewrites the index.
	const status = await runGit(worktreePath, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"]);
	if (status.ok || !isUnreadableIndexError(status.stderr)) {
		return null;
	}
	const indexPath = await runGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
	if (!indexPath.ok || !indexPath.stdout) {
		return null;
	}
	return { indexPath: indexPath.stdout, error: status.stderr.replace(/^fatal: /u, "") };
}

export type WorktreeIndexRepair =
	| { repaired: true; indexPath: string; keptAs: string; error: string }
	| { repaired: false; indexPath: string; error: string };

function stamp(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/u, "Z");
}

/**
 * Rebuilds an unreadable index from HEAD, keeping the damaged one next to it as `index.damaged-<stamp>`. Null when
 * the index is readable. Take a WIP tag first (tagRestartWip copes with an unreadable index): what was staged only
 * is in the tag, not in the new index.
 */
export async function repairUnreadableWorktreeIndex(
	worktreePath: string,
	now: Date = new Date(),
): Promise<WorktreeIndexRepair | null> {
	const damaged = await findUnreadableWorktreeIndex(worktreePath);
	if (!damaged) {
		return null;
	}
	const keptAs = `${damaged.indexPath}.damaged-${stamp(now)}`;
	try {
		await rename(damaged.indexPath, keptAs);
	} catch (error) {
		return {
			repaired: false,
			indexPath: damaged.indexPath,
			error: `could not set the index aside: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const rebuilt = await runGit(worktreePath, ["read-tree", "HEAD"]);
	if (!rebuilt.ok) {
		// A missing index reads as "every file deleted"; the damaged one at least says what it is.
		await rename(keptAs, damaged.indexPath).catch(() => {});
		return {
			repaired: false,
			indexPath: damaged.indexPath,
			error: rebuilt.stderr || rebuilt.error || "git read-tree failed",
		};
	}
	return { repaired: true, indexPath: damaged.indexPath, keptAs, error: damaged.error };
}

/** One line for a decision record or a CLI answer. */
export function describeWorktreeIndexRepair(repair: WorktreeIndexRepair): string {
	return repair.repaired
		? `rebuilt its unreadable git index from HEAD (${repair.error}; the damaged one is kept as ${repair.keptAs})`
		: `its git index is unreadable and could not be rebuilt (${repair.error})`;
}
