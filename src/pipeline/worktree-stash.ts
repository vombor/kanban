// Stash entries a card's worktree made (issue #22: notes' 248ae ran `git stash -u && git checkout --detach main &&
// git stash pop`, the pop conflicted, and the agent left a clean worktree on main with all its work in the stash;
// the submission stage then called the empty snapshot "the agent likely never ran").
//
// The stash is shared by every worktree of a repository, so an entry is the worktree's only when its first parent
// (the HEAD it was made on) was this worktree's HEAD at the time it was made, read from the worktree's own HEAD
// reflog, and its branch (`On <branch>:` in the message) isn't one another worktree has checked out (the user's
// stash in the main checkout, made on the commit a new card's worktree sits on). Another detached worktree stashing
// on the same commit within the same span would still match; the caller reports it as "looks like", never acts on
// it.
import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "../workspace/git-utils";

export interface WorktreeStash {
	/** The stash commit: `git stash apply <sha>` restores it. */
	sha: string;
	/** `stash@{n}` when it was read; the index moves with every new stash, the sha doesn't. */
	ref: string;
	/** The HEAD it was made on. */
	head: string;
	/** Epoch ms. */
	at: number;
	message: string;
}

const FIELD = "\u001f";

async function gitLines(cwd: string, args: string[]): Promise<string[] | null> {
	const result = await runGit(cwd, args, { env: createGitProcessEnv() });
	return result.ok ? result.stdout.split("\n").filter((line) => line.length > 0) : null;
}

/** When the worktree's HEAD sat on which commit, newest first: `[head, from, until]` in epoch seconds. */
function readHeadSpans(lines: string[]): Array<{ head: string; from: number; until: number }> {
	const entries = lines.flatMap((line) => {
		const [head, selector] = line.split(FIELD);
		const at = Number(/@\{(\d+)\}$/u.exec(selector ?? "")?.[1]);
		return head && Number.isFinite(at) ? [{ head, at }] : [];
	});
	return entries.map((entry, index) => ({
		head: entry.head,
		from: entry.at,
		until: index === 0 ? Number.POSITIVE_INFINITY : (entries[index - 1]?.at ?? Number.POSITIVE_INFINITY),
	}));
}

/** Branches checked out in the repository's other worktrees, from `git worktree list --porcelain`. */
function readOtherWorktreeBranches(lines: string[], topLevel: string): Set<string> {
	const branches = new Set<string>();
	let path: string | null = null;
	for (const line of lines) {
		if (line.startsWith("worktree ")) {
			path = line.slice("worktree ".length);
		} else if (line.startsWith("branch refs/heads/") && path !== topLevel) {
			branches.add(line.slice("branch refs/heads/".length));
		}
	}
	return branches;
}

/** The branch a stash message names (`On main: …`, `WIP on main: …`), or null for a detached HEAD. */
function readStashBranch(message: string): string | null {
	const branch = /^(?:WIP on|On) (.+?): /u.exec(message)?.[1] ?? null;
	return branch === "(no branch)" ? null : branch;
}

/** The stash entries made on this worktree's HEAD, newest first; none when git can't read them. */
export async function findWorktreeStashes(worktreePath: string): Promise<WorktreeStash[]> {
	const [stashLines, reflogLines, worktreeLines, topLevel] = await Promise.all([
		gitLines(worktreePath, ["stash", "list", `--format=%H${FIELD}%P${FIELD}%ct${FIELD}%gs`]),
		gitLines(worktreePath, ["reflog", "show", "--date=unix", `--format=%H${FIELD}%gd`, "HEAD"]),
		gitLines(worktreePath, ["worktree", "list", "--porcelain"]),
		gitLines(worktreePath, ["rev-parse", "--show-toplevel"]),
	]);
	if (!stashLines || !reflogLines) {
		return [];
	}
	const spans = readHeadSpans(reflogLines);
	const otherBranches = readOtherWorktreeBranches(worktreeLines ?? [], topLevel?.[0] ?? "");
	return stashLines.flatMap((line, index) => {
		const [sha, parents, time, message] = line.split(FIELD);
		const head = parents?.split(" ")[0];
		const at = Number(time);
		if (!sha || !head || !Number.isFinite(at)) {
			return [];
		}
		const branch = readStashBranch(message ?? "");
		const mine =
			(branch === null || !otherBranches.has(branch)) &&
			spans.some((span) => span.head === head && span.from <= at && at <= span.until);
		return mine ? [{ sha, ref: `stash@{${index}}`, head, at: at * 1000, message: message ?? "" }] : [];
	});
}

/** The sentence a report names the stash with, and how to get it back. */
export function describeWorktreeStashes(stashes: WorktreeStash[]): string {
	const listed = stashes
		.map(
			(stash) =>
				`${stash.ref} ${stash.sha.slice(0, 8)} ("${stash.message}", made on ${stash.head.slice(0, 8)} at ${new Date(stash.at).toISOString()})`,
		)
		.join(", ");
	const newest = stashes[0]?.sha ?? "<sha>";
	return `the card's work looks stranded in the stash: ${listed}; restore it in the worktree with git stash apply ${newest} (by sha, never stash pop)`;
}
