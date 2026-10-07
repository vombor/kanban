import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createRepoWithWorktree } from "../../utilities/git-repo";
import { createLandRepo } from "../../utilities/land-repo";
import { createTempDir } from "../../utilities/temp-dir";

// What the tests run by a git hook did on 2026-10-07: git init / commit / worktree add / config in temp repos.
it("runs temp-repo git commands without the hook's git environment", () => {
	expect(process.env.GIT_DIR).toBeUndefined();
	expect(process.env.GIT_INDEX_FILE).toBeUndefined();
	expect(process.env.GIT_WORK_TREE).toBeUndefined();
	expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
	expect(process.env.GIT_CONFIG_GLOBAL?.startsWith(tmpdir())).toBe(true);

	const repo = createRepoWithWorktree("kanban-git-env-leak-");
	const land = createLandRepo();
	const raw = createTempDir("kanban-git-env-leak-raw-");
	try {
		land.addWorktree("card-1");
		land.write(land.repoPath, "change.txt", "x\n");
		land.commitAll(land.repoPath, "change");
		// A careless test that spawns git with the inherited process.env.
		const git = (args: string[]) => execFileSync("git", args, { cwd: raw.path, stdio: "ignore" });
		git(["init", "-q", "-b", "main"]);
		git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
		git(["worktree", "add", "-q", join(raw.path, "card-2"), "-b", "card-2"]);
		git(["config", "core.bare", "true"]);
	} finally {
		repo.cleanup();
		land.cleanup();
		raw.cleanup();
	}
});
