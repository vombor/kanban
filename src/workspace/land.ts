// Kanban lands a card's work onto its base branch itself (landing mode `qa`, plan §4.2): one squash commit on the
// base, made before the card goes to Done, so a conflict found here keeps the card in Review.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (land, mergeCheck, checkoutOf,
// commitMessage, postLand, snapshotWorktree) with these changes:
// - The work is the card's pre-land snapshot (src/pipeline/snapshots.ts: HEAD + uncommitted + untracked files),
//   not the trashed-task patch: landing runs before Done now.
// - A dirty checked-out base is stashed and restored by the stash commit's sha, never `stash pop`: the stash
//   stack is shared with every other worktree and session of the repo.
// - Git commands that hit another process's index.lock are retried (legacy kit 4554284, not in the archive:
//   4018c 10/07 01:03Z, its land threw on a Kanban checkpoint's index.lock and the QA PASS never landed).
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { RuntimeTaskIssue } from "../core/api-contract";
import { type CardRoleInput, resolveCardRole } from "../core/card-role";
import { createGitProcessEnv } from "../core/git-process-env";
import { buildIssueClosingLine } from "../issues/issue-provider";
import { SNAPSHOT_GIT_IDENTITY } from "../pipeline/snapshots";
import { runGit } from "./git-utils";

const INDEX_LOCK_PATTERN = /index\.lock'?: File exists/u;
const DEFAULT_LOCK_RETRY_MS = 20_000;
const LOCK_RETRY_STEP_MS = 1_000;
const POST_LAND_TIMEOUT_MS = 5 * 60_000;
const COMMIT_TITLE_MAX = 72;

export interface PostLandStep {
	/** Regex source; the step runs when a landed path matches. */
	paths: string;
	run: string;
	/** Directories (relative to the checkout) whose processes are stopped after `run`. */
	stopUnder?: string[];
}

export interface LandGitOptions {
	/** How long a command waits out a foreign index.lock. */
	lockRetryMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export type LandCheck =
	| { status: "clean"; baseSha: string; mergedTree: string }
	| { status: "noop"; baseSha: string }
	| { status: "conflict"; baseSha: string; files: string[] }
	| { status: "error"; error: string };

export type LandResult =
	| { status: "landed"; baseRef: string; commit: string; previousBaseSha: string; checkout: string | null }
	| { status: "noop"; baseRef: string }
	| { status: "conflict"; baseRef: string; files: string[] }
	| { status: "error"; baseRef: string; error: string };

export interface PostLandOutcome {
	paths: string;
	run: string;
	ok: boolean;
	detail: string;
}

export interface LandCommitInput extends LandGitOptions {
	repoPath: string;
	baseRef: string;
	commit: string;
	message: { title: string; body: string };
	/** For the stash message and log lines. */
	taskId: string;
	postLand?: readonly PostLandStep[];
	/** Stops the processes under these absolute directories (postLand `stopUnder`). */
	stopProcessesUnder?: (directories: string[]) => Promise<void>;
	log?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function git(
	cwd: string,
	args: string[],
	options: LandGitOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<Awaited<ReturnType<typeof runGit>>> {
	const sleep = options.sleep ?? defaultSleep;
	const deadline = Date.now() + (options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
	for (;;) {
		const result = await runGit(cwd, args, { env: options.env });
		if (result.ok || !INDEX_LOCK_PATTERN.test(result.stderr) || Date.now() >= deadline) {
			return result;
		}
		await sleep(LOCK_RETRY_STEP_MS);
	}
}

async function gitOut(cwd: string, args: string[], options: LandGitOptions & { env?: NodeJS.ProcessEnv } = {}) {
	const result = await git(cwd, args, options);
	if (!result.ok) {
		throw new Error(result.error ?? `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

function toBranchRef(baseRef: string): string {
	return baseRef.startsWith("refs/") ? baseRef : `refs/heads/${baseRef}`;
}

/** The repository's own committer identity, else Kanban's, so a broken gitconfig can't stop a land. */
async function commitIdentityEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
	const ident = await runGit(cwd, ["var", "GIT_COMMITTER_IDENT"]);
	if (ident.ok) {
		return createGitProcessEnv();
	}
	return createGitProcessEnv(SNAPSHOT_GIT_IDENTITY);
}

/**
 * The landing commit's message. A dev card imported from an issue closes it (`Fixes #N` for GitHub, once the commit
 * reaches the default branch); a plan card made from an issue lands only its spec, so it doesn't.
 */
export function buildLandCommitMessage(
	card: { id: string; title?: string; prompt: string; issue?: RuntimeTaskIssue } & CardRoleInput,
): {
	title: string;
	body: string;
} {
	const firstLine = (card.title?.trim() || card.prompt.trim() || card.id).split("\n")[0]?.trim() ?? card.id;
	const closing = card.issue && resolveCardRole(card) === "dev" ? buildIssueClosingLine(card.issue) : null;
	return {
		title: firstLine.slice(0, COMMIT_TITLE_MAX),
		body: [`Landed by Kanban from task ${card.id}.`, ...(closing ? ["", closing] : [])].join("\n"),
	};
}

/** Would `commit` squash cleanly onto `baseRef`? Read-only: merge-tree writes objects, never a worktree. */
export async function checkLand(
	input: { repoPath: string; baseRef: string; commit: string } & LandGitOptions,
): Promise<LandCheck> {
	const base = await git(input.repoPath, ["rev-parse", "-q", "--verify", toBranchRef(input.baseRef)], input);
	if (!base.ok || !base.stdout) {
		return { status: "error", error: `base branch ${input.baseRef} not found` };
	}
	const baseSha = base.stdout;
	const merge = await git(
		input.repoPath,
		["merge-tree", "--write-tree", "--name-only", "--no-messages", baseSha, input.commit],
		input,
	);
	const [tree, ...files] = merge.stdout.split("\n").filter(Boolean);
	if (!merge.ok && merge.exitCode === 1 && /^[0-9a-f]{40,64}$/u.test(tree ?? "")) {
		return { status: "conflict", baseSha, files };
	}
	if (!merge.ok || !tree) {
		return { status: "error", error: `git merge-tree failed: ${(merge.stderr || merge.stdout).slice(0, 200)}` };
	}
	const baseTree = await gitOut(input.repoPath, ["rev-parse", `${baseSha}^{tree}`], input);
	return tree === baseTree ? { status: "noop", baseSha } : { status: "clean", baseSha, mergedTree: tree };
}

/** The worktree that has `baseRef` checked out (usually the main repository), or null. */
export async function findBranchCheckout(repoPath: string, baseRef: string): Promise<string | null> {
	const list = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
	if (!list.ok) {
		return null;
	}
	const branchLine = `branch ${toBranchRef(baseRef)}`;
	let current: string | null = null;
	for (const line of list.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = line.slice("worktree ".length);
		} else if (line === branchLine) {
			return current;
		}
	}
	return null;
}

function runShell(command: string, cwd: string): Promise<{ ok: boolean; detail: string }> {
	return new Promise((done) => {
		const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const collect = (chunk: Buffer) => {
			output = `${output}${chunk.toString("utf8")}`.slice(-4_000);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => child.kill("SIGKILL"), POST_LAND_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			done({ ok: false, detail: error.message });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const tail = output.trim().slice(-200);
			done(code === 0 ? { ok: true, detail: tail } : { ok: false, detail: `exit ${code ?? signal}: ${tail}` });
		});
	});
}

/**
 * postLand rules: when the landed change touches matching paths, run the command in the checkout and stop the
 * processes under `stopUnder` (the preview restarts them). Ported from
 * archive/devteam-kit:services/kanban-autoland.mjs@264680f (prisma/ changed → generate + migrate deploy + stop
 * the API; a stale Prisma client 500'd master logins, 10/05).
 */
export async function runPostLand(input: {
	checkout: string;
	from: string;
	to: string;
	steps: readonly PostLandStep[];
	stopProcessesUnder?: (directories: string[]) => Promise<void>;
}): Promise<PostLandOutcome[]> {
	if (input.steps.length === 0) {
		return [];
	}
	const changed = (await gitOut(input.checkout, ["diff", "--name-only", input.from, input.to]))
		.split("\n")
		.filter(Boolean);
	const outcomes: PostLandOutcome[] = [];
	for (const step of input.steps) {
		const pattern = new RegExp(step.paths, "u");
		if (!changed.some((path) => pattern.test(path))) {
			continue;
		}
		const ran = await runShell(step.run, input.checkout);
		if (step.stopUnder?.length && input.stopProcessesUnder) {
			await input.stopProcessesUnder(step.stopUnder.map((directory) => resolve(input.checkout, directory)));
		}
		outcomes.push({ paths: step.paths, run: step.run, ok: ran.ok, detail: ran.detail });
	}
	return outcomes;
}

async function restoreStash(checkout: string, stashSha: string, options: LandGitOptions): Promise<string | null> {
	const applied = await git(checkout, ["stash", "apply", stashSha], options);
	if (!applied.ok) {
		return `restoring the stashed edits conflicted in ${checkout}; they are still in the stash list (${stashSha.slice(0, 8)})`;
	}
	const list = await runGit(checkout, ["stash", "list", "--format=%H"]);
	const index = list.ok ? list.stdout.split("\n").indexOf(stashSha) : -1;
	if (index >= 0) {
		await git(checkout, ["stash", "drop", `stash@{${index}}`], options);
	}
	return null;
}

/**
 * Squash-lands `commit` onto `baseRef`. Base not checked out anywhere: commit-tree + update-ref (compare-and-swap
 * on the old tip). Checked out (usually the main repository): `merge --squash` + commit there, with the user's
 * uncommitted edits stashed and restored around it; postLand runs in that checkout.
 */
export async function landCommit(input: LandCommitInput): Promise<LandResult> {
	const { baseRef } = input;
	const log = input.log ?? (() => {});
	try {
		const check = await checkLand(input);
		if (check.status === "error") {
			return { status: "error", baseRef, error: check.error };
		}
		if (check.status === "noop") {
			return { status: "noop", baseRef };
		}
		if (check.status === "conflict") {
			return { status: "conflict", baseRef, files: check.files };
		}
		const message = ["-m", input.message.title, "-m", input.message.body];
		const identity = await commitIdentityEnv(input.repoPath);
		const checkout = await findBranchCheckout(input.repoPath, baseRef);
		if (!checkout) {
			const commit = await gitOut(
				input.repoPath,
				["commit-tree", check.mergedTree, "-p", check.baseSha, ...message],
				{ ...input, env: identity },
			);
			await gitOut(
				input.repoPath,
				["update-ref", "-m", `kanban land ${input.taskId}`, toBranchRef(baseRef), commit, check.baseSha],
				input,
			);
			return { status: "landed", baseRef, commit, previousBaseSha: check.baseSha, checkout: null };
		}

		const checkoutHead = await gitOut(checkout, ["rev-parse", "HEAD"], input);
		if (checkoutHead !== check.baseSha) {
			return { status: "error", baseRef, error: `${checkout} is not at the tip of ${baseRef}` };
		}
		const dirty = (await gitOut(checkout, ["status", "--porcelain"], input)) !== "";
		let stashSha: string | null = null;
		if (dirty) {
			await gitOut(checkout, ["stash", "push", "-u", "-m", `kanban-land-${input.taskId}`], input);
			stashSha = await gitOut(checkout, ["rev-parse", "-q", "--verify", "refs/stash"], input);
		}
		let landedCommit: string;
		try {
			const squash = await git(checkout, ["merge", "--squash", input.commit], input);
			if (!squash.ok) {
				await git(checkout, ["reset", "--merge"], input);
				return {
					status: "error",
					baseRef,
					error: `squash merge failed in ${checkout}: ${(squash.stderr || squash.stdout).slice(0, 200)}`,
				};
			}
			// No hooks: a repo pre-commit hook (tests, lint) must not run inside an automated land.
			const committed = await git(checkout, ["commit", "-q", "--no-verify", ...message], {
				...input,
				env: identity,
			});
			if (!committed.ok) {
				// Leave the checkout as it was: drop the staged squash before the user's edits come back.
				await git(checkout, ["reset", "--merge"], input);
				return {
					status: "error",
					baseRef,
					error: `commit failed in ${checkout}: ${(committed.stderr || committed.stdout).slice(0, 200)}`,
				};
			}
			landedCommit = await gitOut(checkout, ["rev-parse", "HEAD"], input);
		} finally {
			if (stashSha) {
				const warning = await restoreStash(checkout, stashSha, input);
				if (warning) {
					log(`land ${input.taskId}: WARNING ${warning}`);
				}
			}
		}
		const outcomes = await runPostLand({
			checkout,
			from: check.baseSha,
			to: landedCommit,
			steps: input.postLand ?? [],
			stopProcessesUnder: input.stopProcessesUnder,
		}).catch((error: unknown) => [
			{ paths: "*", run: "postLand", ok: false, detail: error instanceof Error ? error.message : String(error) },
		]);
		for (const outcome of outcomes) {
			log(
				`land ${input.taskId}: post-land (${outcome.paths}) ${outcome.ok ? "ok" : `FAILED (${outcome.detail})`}: ${outcome.run}`,
			);
		}
		return { status: "landed", baseRef, commit: landedCommit, previousBaseSha: check.baseSha, checkout };
	} catch (error) {
		return { status: "error", baseRef, error: error instanceof Error ? error.message : String(error) };
	}
}

/** `git tag -f <tag> <commit>`: keeps work that is not landed (a discarded hold, a runoff loser). */
export async function tagPreservedWork(input: { repoPath: string; tag: string; commit: string }): Promise<void> {
	if (!input.tag.startsWith("preserve/")) {
		throw new Error(`preserve tags start with "preserve/": ${input.tag}`);
	}
	await gitOut(input.repoPath, ["tag", "-f", input.tag, input.commit]);
}
