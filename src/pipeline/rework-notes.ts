// What the rework stage reads and writes in a card's worktree: the QA write-up and artifacts copied in as
// `.qa/r<N>/` (git-ignored through the repo's info/exclude, so snapshots, QA and landing never see it), and whether
// the worktree sits on an older base than its base branch's tip.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (stageQaInWorktree, behindBase) and @b6bbe71
// (card agents get no access to the Kanban home, so the notes come to them; HTML reports and files over 512 KB stay
// behind: Cline's search ignores .gitignore, and a 9 MB report overflowed luna's context on 10/05).
import { access, appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "../workspace/git-utils";
import { getTaskWorktreeCandidatePaths } from "../workspace/task-worktree";
import type { StaleBase } from "./rework-text";

const QA_NOTES_MAX_BYTES = 512 * 1024;
const QA_NOTES_DIR = ".qa";
const EXCLUDE_LINE = "/.qa/";

async function exists(path: string): Promise<boolean> {
	return await access(path).then(
		() => true,
		() => false,
	);
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
	const result = await runGit(cwd, args, { env: createGitProcessEnv() });
	return { ok: result.ok, stdout: result.stdout.trim() };
}

/** The card's worktree when it exists (any of its candidate roots), else null. */
export async function findTaskWorktree(workspacePath: string, taskId: string): Promise<string | null> {
	for (const candidate of getTaskWorktreeCandidatePaths(workspacePath, taskId)) {
		if (await exists(candidate)) {
			return candidate;
		}
	}
	return null;
}

export interface StageQaNotesInput {
	worktreePath: string;
	round: number;
	/** The QA card's artifacts as the QA gate kept them (`data/<ws>/qa-artifacts/<id>/r<N>`). */
	artifactsDir: string;
	/** The QA log section of that round; written as QA.md. */
	qaSection: string;
}

/** Copies the round's QA notes into `<worktree>/.qa/r<N>/` and returns that path relative to the worktree. */
export async function stageQaNotes(input: StageQaNotesInput): Promise<string> {
	const { worktreePath } = input;
	const commonDir = await git(worktreePath, ["rev-parse", "--git-common-dir"]);
	if (!commonDir.ok || !commonDir.stdout) {
		throw new Error(`${worktreePath} is not a git worktree`);
	}
	const exclude = join(resolve(worktreePath, commonDir.stdout), "info", "exclude");
	const current = await readFile(exclude, "utf8").catch(() => "");
	if (!current.split("\n").includes(EXCLUDE_LINE)) {
		await mkdir(dirname(exclude), { recursive: true });
		await appendFile(
			exclude,
			`${current && !current.endsWith("\n") ? "\n" : ""}# Kanban: QA notes copied into worktrees for reworks\n${EXCLUDE_LINE}\n`,
		);
	}
	const rel = join(QA_NOTES_DIR, `r${input.round}`);
	const dest = join(worktreePath, rel);
	await rm(dest, { recursive: true, force: true });
	await mkdir(dest, { recursive: true });
	const skipped: string[] = [];
	const copy = async (from: string, to: string): Promise<void> => {
		for (const entry of await readdir(from, { withFileTypes: true })) {
			const source = join(from, entry.name);
			const target = join(to, entry.name);
			if (entry.isDirectory()) {
				await mkdir(target, { recursive: true });
				await copy(source, target);
			} else if (entry.isFile()) {
				if (/\.html?$/iu.test(entry.name) || (await stat(source)).size > QA_NOTES_MAX_BYTES) {
					skipped.push(relative(input.artifactsDir, source));
				} else {
					await copyFile(source, target);
				}
			}
		}
	};
	if (await exists(input.artifactsDir)) {
		await copy(input.artifactsDir, dest);
	}
	await writeFile(
		join(dest, "QA.md"),
		`${input.qaSection.trim() || "(no QA write-up found)"}\n${skipped.length > 0 ? `\nNot copied (HTML or over 512 KB): ${skipped.join(", ")}\n` : ""}`,
		"utf8",
	);
	if (!(await git(worktreePath, ["check-ignore", "-q", rel])).ok) {
		throw new Error(`${rel} is not ignored in ${worktreePath}`);
	}
	return rel;
}

/** The worktree's HEAD and the base tip when HEAD is a strict ancestor of `refs/heads/<baseRef>`, else null. */
export async function readStaleBase(input: {
	workspacePath: string;
	worktreePath: string;
	baseRef: string;
}): Promise<StaleBase | null> {
	const head = await git(input.worktreePath, ["rev-parse", "HEAD"]);
	const tip = await git(input.workspacePath, ["rev-parse", "-q", "--verify", `refs/heads/${input.baseRef}`]);
	if (!head.ok || !tip.ok || !head.stdout || !tip.stdout || head.stdout === tip.stdout) {
		return null;
	}
	const ancestor = await git(input.workspacePath, ["merge-base", "--is-ancestor", head.stdout, tip.stdout]);
	return ancestor.ok ? { head: head.stdout, tip: tip.stdout } : null;
}
