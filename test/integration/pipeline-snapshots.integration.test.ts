// Snapshots on real temp repos: the worktree's index, HEAD and files stay as they are, untracked files are in the
// snapshot and ignored ones are not, an unchanged tree reuses the previous commit, a dry run (shadow) moves no ref,
// and the commit never uses the user's git identity.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	getSnapshotRef,
	readTaskSnapshot,
	SNAPSHOT_GIT_IDENTITY,
	snapshotHasChanges,
	takeTaskSnapshot,
} from "../../src/pipeline/snapshots";
import { createRepoWithWorktree, git } from "../utilities/git-repo";

describe("task snapshots", () => {
	const repos: Array<{ cleanup: () => void }> = [];
	const createRepo = () => {
		const repo = createRepoWithWorktree();
		repos.push(repo);
		return repo;
	};
	afterEach(() => {
		for (const repo of repos.splice(0)) {
			repo.cleanup();
		}
	});

	it("commits tracked and untracked changes to refs/kanban/snapshots/<id> without touching the worktree", async () => {
		const { repoPath, worktreePath } = createRepo();
		writeFileSync(join(worktreePath, "README.md"), "changed\n");
		writeFileSync(join(worktreePath, "new.txt"), "new\n");
		writeFileSync(join(worktreePath, "ignored.txt"), "secret\n");
		const headBefore = git(worktreePath, ["rev-parse", "HEAD"]);
		const statusBefore = git(worktreePath, ["status", "--porcelain"]);

		const snapshot = await takeTaskSnapshot({
			worktreePath,
			taskId: "abc12",
			baseRef: "main",
			reason: "review",
			dryRun: false,
		});

		expect(snapshot).toMatchObject({
			parent: headBefore,
			previous: null,
			changed: true,
			hasChanges: true,
			recorded: true,
		});
		// The ref is shared with the main repo (refs live in the common dir).
		expect(git(repoPath, ["rev-parse", getSnapshotRef("abc12")])).toBe(snapshot.commit);
		expect(git(repoPath, ["show", `${snapshot.commit}:new.txt`])).toBe("new");
		expect(git(repoPath, ["show", `${snapshot.commit}:README.md`])).toBe("changed");
		expect(() => git(repoPath, ["show", `${snapshot.commit}:ignored.txt`])).toThrow();
		expect(git(repoPath, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", snapshot.commit])).toBe(
			`${SNAPSHOT_GIT_IDENTITY.GIT_AUTHOR_NAME} <${SNAPSHOT_GIT_IDENTITY.GIT_AUTHOR_EMAIL}>|${SNAPSHOT_GIT_IDENTITY.GIT_COMMITTER_NAME} <${SNAPSHOT_GIT_IDENTITY.GIT_COMMITTER_EMAIL}>|kanban snapshot abc12 (review)`,
		);
		expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(headBefore);
		expect(git(worktreePath, ["status", "--porcelain"])).toBe(statusBefore);
		expect(existsSync(join(worktreePath, "new.txt"))).toBe(true);
	});

	it("reuses the previous snapshot for an unchanged tree and makes a new one after a change", async () => {
		const { worktreePath } = createRepo();
		writeFileSync(join(worktreePath, "a.txt"), "1\n");
		const first = await takeTaskSnapshot({
			worktreePath,
			taskId: "t1",
			baseRef: "main",
			reason: "review",
			dryRun: false,
		});
		const again = await takeTaskSnapshot({
			worktreePath,
			taskId: "t1",
			baseRef: "main",
			reason: "review",
			dryRun: false,
		});
		expect(again).toMatchObject({ commit: first.commit, previous: first.commit, changed: false, recorded: true });

		writeFileSync(join(worktreePath, "a.txt"), "2\n");
		const next = await takeTaskSnapshot({
			worktreePath,
			taskId: "t1",
			baseRef: "main",
			reason: "review",
			dryRun: false,
		});
		expect(next.commit).not.toBe(first.commit);
		expect(next.previous).toBe(first.commit);
		expect(await readTaskSnapshot(worktreePath, "t1")).toBe(next.commit);
	});

	it("dry run (shadow) builds the commit but leaves the ref alone", async () => {
		const { repoPath, worktreePath } = createRepo();
		writeFileSync(join(worktreePath, "a.txt"), "1\n");

		const snapshot = await takeTaskSnapshot({
			worktreePath,
			taskId: "t1",
			baseRef: "main",
			reason: "review",
			dryRun: true,
		});

		expect(snapshot).toMatchObject({ changed: true, recorded: false, hasChanges: true });
		expect(await readTaskSnapshot(repoPath, "t1")).toBeNull();
		expect(git(repoPath, ["cat-file", "-t", snapshot.commit])).toBe("commit");
	});

	it("a snapshot equal to its base has no changes; commits on the base after the card started don't count", async () => {
		const { repoPath, worktreePath } = createRepo();
		const empty = await takeTaskSnapshot({
			worktreePath,
			taskId: "t1",
			baseRef: "main",
			reason: "review",
			dryRun: false,
		});
		expect(empty.hasChanges).toBe(false);

		// The base moves on; the card's snapshot still equals its merge-base.
		writeFileSync(join(repoPath, "base.txt"), "later\n");
		git(repoPath, ["add", "-A"]);
		git(repoPath, ["commit", "-q", "-m", "later"]);
		expect(await snapshotHasChanges(worktreePath, empty.commit, "main")).toBe(false);

		// A committed change in the worktree counts.
		writeFileSync(join(worktreePath, "work.txt"), "work\n");
		git(worktreePath, ["add", "-A"]);
		git(worktreePath, ["commit", "-q", "-m", "work"]);
		const committed = await takeTaskSnapshot({
			worktreePath,
			taskId: "t1",
			baseRef: "main",
			reason: "review",
			dryRun: false,
		});
		expect(committed.hasChanges).toBe(true);
	});

	it("an unknown base counts as changes, so a missing ref never drops a card", async () => {
		const { worktreePath } = createRepo();
		const snapshot = await takeTaskSnapshot({
			worktreePath,
			taskId: "t1",
			baseRef: "no-such-branch",
			reason: "review",
			dryRun: false,
		});
		expect(snapshot.hasChanges).toBe(true);
	});
});
