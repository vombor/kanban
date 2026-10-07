import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createGitTestEnv } from "./git-env";
import { createTempDir } from "./temp-dir";

export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: createGitTestEnv(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * A temp repo with one commit on `main` and a task worktree (`<root>/worktree`, detached at main), the layout a
 * Kanban card has.
 */
export function createRepoWithWorktree(prefix = "kanban-repo-") {
	const temp = createTempDir(prefix);
	const repoPath = join(temp.path, "repo");
	const worktreePath = join(temp.path, "worktree");
	execFileSync("git", ["init", "-q", "-b", "main", repoPath], { env: createGitTestEnv() });
	writeFileSync(join(repoPath, "README.md"), "hello\n");
	writeFileSync(join(repoPath, ".gitignore"), "ignored.txt\n");
	git(repoPath, ["add", "-A"]);
	git(repoPath, ["commit", "-q", "-m", "init"]);
	git(repoPath, ["worktree", "add", "-q", "--detach", worktreePath, "main"]);
	return { root: temp.path, repoPath, worktreePath, cleanup: temp.cleanup };
}
