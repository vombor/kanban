import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createGitTestEnv } from "./git-env";
import { createTempDir } from "./temp-dir";

/**
 * A temp repository for land tests: `repo/` on branch `main` with one commit, and task worktrees under
 * `worktrees/<taskId>` (detached at `main`, as Kanban creates them).
 */
export function createLandRepo() {
	const temp = createTempDir("kanban-land-");
	const repoPath = join(temp.path, "repo");
	mkdirSync(repoPath, { recursive: true });
	const env = createGitTestEnv();
	const git = (args: string[], cwd = repoPath): string =>
		execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const write = (cwd: string, path: string, content: string): void => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), content);
	};
	const commitAll = (cwd: string, message: string): string => {
		git(["add", "-A"], cwd);
		git(["commit", "-q", "-m", message], cwd);
		return git(["rev-parse", "HEAD"], cwd);
	};

	git(["init", "-q", "-b", "main"]);
	git(["config", "user.name", "Test"]);
	git(["config", "user.email", "test@test.com"]);
	write(repoPath, "README.md", "hello\n");
	write(repoPath, "src/app.ts", "export const value = 1;\n");
	commitAll(repoPath, "initial");

	return {
		root: temp.path,
		repoPath,
		git,
		write,
		commitAll,
		/** `path`: where Kanban would put it (getTaskWorktreeCandidatePaths), when the code under test looks it up. */
		addWorktree: (taskId: string, path = join(temp.path, "worktrees", taskId), base = "main"): string => {
			git(["worktree", "add", "-q", "--detach", path, base]);
			return path;
		},
		tip: (branch = "main"): string => git(["rev-parse", `refs/heads/${branch}`]),
		cleanup: temp.cleanup,
	};
}
