import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stripReworkSections } from "../../../src/commands/task-recovery";
import { cleanGeneratedReports } from "../../../src/pipeline/recovery-runtime";
import { hasTrackedChanges, nextRestartWipTag, preserveWorktree, tagRestartWip } from "../../../src/pipeline/wip-tag";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, env: createGitTestEnv(), encoding: "utf8" }).trim();
}

describe("WIP tags (archive/devteam-kit:lib/resume.mjs tagWip)", () => {
	let temp: { path: string; cleanup: () => void };
	let repo: string;

	beforeEach(() => {
		temp = createTempDir("kanban-wip-");
		repo = temp.path;
		git(repo, ["init", "-q", "-b", "main"]);
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, ".gitignore"), "coverage/\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-q", "-m", "base"]);
	});

	afterEach(() => {
		temp.cleanup();
	});

	it("tags tracked and untracked work without touching the worktree or its index", async () => {
		expect(await hasTrackedChanges(repo)).toBe(false);
		writeFileSync(join(repo, "a.txt"), "two\n");
		writeFileSync(join(repo, "new.txt"), "untracked\n");
		expect(await hasTrackedChanges(repo)).toBe(true);
		const statusBefore = git(repo, ["status", "--porcelain"]);

		const now = new Date("2026-10-07T12:34:00.000Z");
		const tag = await tagRestartWip(repo, "abc12", now);
		expect(tag).toBe("preserve/abc12-wip-20261007T1234-restart");
		expect(git(repo, ["show", `${tag}:a.txt`])).toBe("two");
		expect(git(repo, ["show", `${tag}:new.txt`])).toBe("untracked");
		expect(git(repo, ["log", "-1", "--format=%an <%ae>", tag ?? ""])).toBe("Kanban <kanban@localhost>");
		expect(git(repo, ["status", "--porcelain"])).toBe(statusBefore);
		// The next restart in the same minute gets a new tag.
		expect(await nextRestartWipTag(repo, "abc12", now)).toBe("preserve/abc12-wip-20261007T1234-restart-2");
	});

	it("moves a named preserve tag only with force", async () => {
		expect(await preserveWorktree(repo, "preserve/abc12-luna", "first")).toBe("preserve/abc12-luna");
		writeFileSync(join(repo, "a.txt"), "three\n");
		expect(await preserveWorktree(repo, "preserve/abc12-luna", "second")).toBeNull();
		expect(await preserveWorktree(repo, "preserve/abc12-luna", "second", { force: true })).toBe(
			"preserve/abc12-luna",
		);
		expect(git(repo, ["show", "preserve/abc12-luna:a.txt"])).toBe("three");
	});

	it("cleans only gitignored generated reports (0a3d1fc)", async () => {
		execFileSync("mkdir", ["-p", join(repo, "coverage"), join(repo, "test-results")]);
		writeFileSync(join(repo, "coverage", "index.html"), "big");
		writeFileSync(join(repo, "test-results", "keep.txt"), "not ignored");
		expect(await cleanGeneratedReports(repo)).toEqual(["coverage"]);
		expect(readFileSync(join(repo, "test-results", "keep.txt"), "utf8")).toBe("not ignored");
		expect(await cleanGeneratedReports(repo)).toEqual([]);
	});
});

describe("stripReworkSections (archive/devteam-kit:tools/restart-fresh.mjs)", () => {
	it("drops REWORK sections and keeps a FINAL STEP after them", () => {
		const prompt =
			"Build it.\n\nREWORK round 1 (FAIL): fix x\n\nREWORK round 2 (FAIL): fix y\n\nFINAL STEP: run tests";
		expect(stripReworkSections(prompt)).toBe("Build it.\n\nFINAL STEP: run tests");
		expect(stripReworkSections("Build it.\n\nREWORK round 1 (FAIL): fix x")).toBe("Build it.");
		expect(stripReworkSections("Build it.")).toBe("Build it.");
	});
});
