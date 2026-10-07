import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { preserveTaskWork } from "../../src/pipeline/hold";
import { takeTaskSnapshot } from "../../src/pipeline/snapshots";
import { buildLandCommitMessage, checkLand, landCommit } from "../../src/workspace/land";
import { getTaskWorktreeCandidatePaths } from "../../src/workspace/task-worktree";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import { createLandRepo } from "../utilities/land-repo";

const MESSAGE = buildLandCommitMessage({ id: "a1b2c", title: "Add the feature", prompt: "" });

/** What lands: the card's pre-land snapshot (P4-2). */
async function snapshot(worktreePath: string) {
	return await takeTaskSnapshot({ worktreePath, taskId: "a1b2c", baseRef: "main", reason: "pre-land", dryRun: false });
}

describe("land: squash a card's work onto its base", () => {
	let repo: ReturnType<typeof createLandRepo>;
	afterEach(() => {
		repo?.cleanup();
	});

	it("lands with commit-tree + update-ref when the base is not checked out", async () => {
		repo = createLandRepo();
		repo.git(["checkout", "-q", "-b", "other"]);
		const worktree = repo.addWorktree("a1b2c");
		repo.write(worktree, "src/app.ts", "export const value = 2;\n");
		const before = repo.tip();
		const source = await snapshot(worktree);

		const result = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: source.commit,
			message: MESSAGE,
			taskId: "a1b2c",
		});

		expect(result).toMatchObject({ status: "landed", baseRef: "main", previousBaseSha: before, checkout: null });
		expect(repo.tip()).toBe(result.status === "landed" ? result.commit : "");
		expect(repo.git(["rev-parse", "main^"])).toBe(before);
		expect(repo.git(["log", "-1", "--format=%B", "main"])).toBe(
			"Add the feature\n\nLanded by Kanban from task a1b2c.",
		);
		expect(repo.git(["show", "main:src/app.ts"])).toBe("export const value = 2;");
	});

	it("squash-merges in the checked-out base and keeps the user's uncommitted edits there", async () => {
		repo = createLandRepo();
		const worktree = repo.addWorktree("a1b2c");
		repo.write(worktree, "src/app.ts", "export const value = 2;\n");
		// The user edits another file in the main checkout, and has an unrelated stash of their own.
		repo.write(repo.repoPath, "README.md", "users stash\n");
		repo.git(["stash", "push", "-q", "-m", "users-own-stash"]);
		repo.write(repo.repoPath, "README.md", "hello, edited\n");
		repo.write(repo.repoPath, "notes.txt", "untracked note\n");
		const source = await snapshot(worktree);

		const result = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: source.commit,
			message: MESSAGE,
			taskId: "a1b2c",
		});

		expect(result).toMatchObject({ status: "landed", checkout: repo.repoPath });
		expect(repo.git(["show", "HEAD:src/app.ts"])).toBe("export const value = 2;");
		expect(readFileSync(join(repo.repoPath, "README.md"), "utf8")).toBe("hello, edited\n");
		expect(readFileSync(join(repo.repoPath, "notes.txt"), "utf8")).toBe("untracked note\n");
		// Kanban's stash is gone, the user's own is untouched.
		expect(repo.git(["stash", "list", "--format=%s"])).toBe("On main: users-own-stash");
	});

	it("leaves the checkout as it was when the commit itself fails", async () => {
		repo = createLandRepo();
		const worktree = repo.addWorktree("a1b2c");
		repo.write(worktree, "src/app.ts", "export const value = 2;\n");
		repo.write(repo.repoPath, "README.md", "hello, edited\n");
		// A signing program that always fails makes `git commit` fail after the squash merge.
		repo.git(["config", "commit.gpgsign", "true"]);
		repo.git(["config", "gpg.program", "false"]);
		const before = repo.tip();
		const source = await snapshot(worktree);

		const result = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: source.commit,
			message: MESSAGE,
			taskId: "a1b2c",
		});

		expect(result).toMatchObject({ status: "error", error: expect.stringContaining("commit failed") });
		expect(repo.tip()).toBe(before);
		expect(repo.git(["status", "--porcelain"])).toBe("M README.md");
		expect(repo.git(["stash", "list"])).toBe("");
	});

	it("reports a conflict with the files and lands nothing", async () => {
		repo = createLandRepo();
		const worktree = repo.addWorktree("a1b2c");
		repo.write(worktree, "src/app.ts", "export const value = 2;\n");
		repo.write(repo.repoPath, "src/app.ts", "export const value = 99;\n");
		repo.commitAll(repo.repoPath, "base moved");
		const before = repo.tip();
		const source = await snapshot(worktree);

		const check = await checkLand({ repoPath: repo.repoPath, baseRef: "main", commit: source.commit });
		const result = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: source.commit,
			message: MESSAGE,
			taskId: "a1b2c",
		});

		expect(check).toMatchObject({ status: "conflict", files: ["src/app.ts"] });
		expect(result).toEqual({ status: "conflict", baseRef: "main", files: ["src/app.ts"] });
		expect(repo.tip()).toBe(before);
	});

	it("is a noop when the base already has the work", async () => {
		repo = createLandRepo();
		const worktree = repo.addWorktree("a1b2c");
		const source = await snapshot(worktree);

		const result = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: source.commit,
			message: MESSAGE,
			taskId: "a1b2c",
		});

		expect(result).toEqual({ status: "noop", baseRef: "main" });
	});

	it("reports a missing base branch", async () => {
		repo = createLandRepo();
		const worktree = repo.addWorktree("a1b2c");
		repo.write(worktree, "x.txt", "x\n");
		const source = await snapshot(worktree);

		expect(
			await landCommit({
				repoPath: repo.repoPath,
				baseRef: "release",
				commit: source.commit,
				message: MESSAGE,
				taskId: "a1b2c",
			}),
		).toEqual({ status: "error", baseRef: "release", error: "base branch release not found" });
	});

	it("waits out a foreign index.lock in the checkout instead of failing (4018c)", async () => {
		repo = createLandRepo();
		const worktree = repo.addWorktree("a1b2c");
		repo.write(worktree, "src/app.ts", "export const value = 2;\n");
		const source = await snapshot(worktree);
		const lockPath = join(repo.repoPath, ".git", "index.lock");
		writeFileSync(lockPath, "");
		const sleep = vi.fn(async () => {
			rmSync(lockPath, { force: true });
		});

		const result = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: source.commit,
			message: MESSAGE,
			taskId: "a1b2c",
			sleep,
		});

		expect(sleep).toHaveBeenCalled();
		expect(result.status).toBe("landed");
		expect(repo.git(["show", "main:src/app.ts"])).toBe("export const value = 2;");
	});

	it("runs postLand steps whose paths changed and stops processes under their dirs", async () => {
		repo = createLandRepo();
		const worktree = repo.addWorktree("a1b2c");
		repo.write(worktree, "prisma/schema.prisma", "model A {}\n");
		const source = await snapshot(worktree);
		const stopProcessesUnder = vi.fn(async () => {});
		const log = vi.fn();

		const result = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: source.commit,
			message: MESSAGE,
			taskId: "a1b2c",
			postLand: [
				{ paths: "^prisma/", run: "echo generated > .post-land-ran", stopUnder: ["api"] },
				{ paths: "^web/", run: "echo never > .never-ran" },
			],
			stopProcessesUnder,
			log,
		});

		expect(result.status).toBe("landed");
		expect(readFileSync(join(repo.repoPath, ".post-land-ran"), "utf8")).toBe("generated\n");
		expect(existsSync(join(repo.repoPath, ".never-ran"))).toBe(false);
		expect(stopProcessesUnder).toHaveBeenCalledWith([join(repo.repoPath, "api")]);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("post-land (^prisma/) ok"));
	});

	it("tags a card's work as a preserve tag, and refuses other tag names", async () => {
		repo = createLandRepo();
		await withTemporaryKanbanHome(
			async () => {
				const worktree = repo.addWorktree("a1b2c", getTaskWorktreeCandidatePaths(repo.repoPath, "a1b2c")[0]);
				repo.write(worktree, "src/app.ts", "export const value = 7;\n");
				const before = repo.tip();

				await expect(
					preserveTaskWork({ workspacePath: repo.repoPath, taskId: "a1b2c", tag: "a1b2c-model" }),
				).rejects.toThrow(/preserve\//u);
				const commit = await preserveTaskWork({
					workspacePath: repo.repoPath,
					taskId: "a1b2c",
					tag: "preserve/a1b2c-model",
				});

				expect(repo.git(["rev-parse", "preserve/a1b2c-model"])).toBe(commit);
				expect(repo.git(["show", "preserve/a1b2c-model:src/app.ts"])).toBe("export const value = 7;");
				expect(repo.tip()).toBe(before);
				await expect(
					preserveTaskWork({ workspacePath: repo.repoPath, taskId: "zzzzz", tag: "preserve/zzzzz" }),
				).rejects.toThrow(/no worktree/u);
			},
			{ env: { KANBAN_WORKTREES: join(repo.root, "kanban-worktrees") } },
		);
	});
});
