import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describeBrokenGitRepository, hasGitRepository } from "../../../src/workspace/repo-health";
import { createRepoWithWorktree, git } from "../../utilities/git-repo";
import { createTempDir } from "../../utilities/temp-dir";

describe("repo health", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("sees a healthy repo as a work tree", () => {
		const repo = createRepoWithWorktree();
		cleanups.push(repo.cleanup);
		expect(hasGitRepository(repo.repoPath)).toBe(true);
	});

	it("reports core.bare=true on a repo whose working tree is still there", () => {
		const repo = createRepoWithWorktree();
		cleanups.push(repo.cleanup);
		git(repo.repoPath, ["config", "core.bare", "true"]);

		expect(hasGitRepository(repo.repoPath)).toBe(false);
		expect(describeBrokenGitRepository(repo.repoPath)).toEqual({
			problem: "its git config says core.bare=true but its working tree is still there",
			hint: `git -C ${repo.repoPath} config core.bare false`,
		});
	});

	it("reports a .git that git can't read", () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		writeFileSync(join(temp.path, ".git"), "not a gitdir line\n");

		expect(hasGitRepository(temp.path)).toBe(false);
		expect(describeBrokenGitRepository(temp.path)?.problem).toBe("it has a .git that git can't read as a work tree");
	});

	it("has nothing to report for a directory without .git", () => {
		const temp = createTempDir();
		cleanups.push(temp.cleanup);
		mkdirSync(join(temp.path, "src"));

		expect(hasGitRepository(temp.path)).toBe(false);
		expect(describeBrokenGitRepository(temp.path)).toBeNull();
	});
});
