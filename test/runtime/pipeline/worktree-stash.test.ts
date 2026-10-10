// Stash entries a card's worktree made, on real temp repos (issue #22).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describeWorktreeStashes, findWorktreeStashes } from "../../../src/pipeline/worktree-stash";
import { createRepoWithWorktree, git } from "../../utilities/git-repo";

describe("worktree stashes", () => {
	const repos: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const repo of repos.splice(0)) {
			repo.cleanup();
		}
	});

	const setup = () => {
		const repo = createRepoWithWorktree("kanban-worktree-stash-");
		repos.push(repo);
		return repo;
	};

	it("finds the stash a worktree made, also after it moved HEAD to the new base", async () => {
		const { repoPath, worktreePath } = setup();
		const head = git(worktreePath, ["rev-parse", "HEAD"]);
		writeFileSync(join(worktreePath, "tags.ts"), "work\n");
		git(worktreePath, ["stash", "push", "-u", "-q", "-m", "card work"]);
		const sha = git(worktreePath, ["rev-parse", "refs/stash"]);
		// main moves on and the worktree checks it out, as the old stale-base step did.
		writeFileSync(join(repoPath, "app.ts"), "main\n");
		git(repoPath, ["add", "-A"]);
		git(repoPath, ["commit", "-q", "-m", "main"]);
		git(worktreePath, ["checkout", "-q", "--detach", "main"]);

		const stashes = await findWorktreeStashes(worktreePath);
		expect(stashes).toEqual([
			{ sha, ref: "stash@{0}", head, at: expect.any(Number), message: "On (no branch): card work" },
		]);
		expect(describeWorktreeStashes(stashes)).toMatch(
			new RegExp(
				`^the card's work looks stranded in the stash: stash@\\{0\\} ${sha.slice(0, 8)} .*git stash apply ${sha} `,
				"u",
			),
		);
	});

	it("ignores a stash the main checkout or another worktree made on another HEAD", async () => {
		const { root, repoPath, worktreePath } = setup();
		writeFileSync(join(repoPath, "app.ts"), "main\n");
		git(repoPath, ["add", "-A"]);
		git(repoPath, ["commit", "-q", "-m", "main"]);
		writeFileSync(join(repoPath, "README.md"), "user edit\n");
		git(repoPath, ["stash", "push", "-q", "-m", "user"]);
		const other = join(root, "other");
		git(repoPath, ["worktree", "add", "-q", "--detach", other, "main"]);
		writeFileSync(join(other, "x.ts"), "x\n");
		git(other, ["stash", "push", "-u", "-q", "-m", "other card"]);

		expect(await findWorktreeStashes(worktreePath)).toEqual([]);
		expect((await findWorktreeStashes(other)).map((stash) => stash.message)).toEqual(["On (no branch): other card"]);
	});

	it("finds nothing without a stash or outside a repository", async () => {
		const { root, worktreePath } = setup();
		expect(await findWorktreeStashes(worktreePath)).toEqual([]);
		expect(await findWorktreeStashes(root)).toEqual([]);
	});
});
