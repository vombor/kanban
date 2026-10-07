import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readStaleBase, stageQaNotes } from "../../../src/pipeline/rework-notes";
import {
	buildPreserveTag,
	buildReworkText,
	insertBeforeFinalStep,
	modelSlug,
	type ReworkTextInput,
	readBlockingBullets,
} from "../../../src/pipeline/rework-text";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = Date.parse("2026-10-07T10:00:00.000Z");

function textInput(overrides: Partial<ReworkTextInput> = {}): ReworkTextInput {
	return {
		taskId: "d1111",
		round: 2,
		verdict: "FAIL",
		blocking: ["cart total wrong"],
		qaSection:
			"## Claude QA d1111 (round 2): FAIL\n- **Blocking**:\n  - cart total wrong\n  - see shot.png\n- Visual: ok",
		conflict: null,
		reworkNumber: 2,
		maxFailRounds: 3,
		baseRef: "main",
		repoPath: "/repos/foo",
		staleBase: null,
		stagedNotes: ".qa/r2",
		qaLogPath: "/home/data/foo/qa-log.md",
		artifactsDir: "/home/data/foo/qa-artifacts/d1111/r2",
		now: NOW,
		...overrides,
	};
}

describe("rework texts", () => {
	it("builds the REWORK section the legacy kit sent", () => {
		expect(buildReworkText(textInput())).toBe(
			[
				"REWORK round 3 (QA round 2: FAIL; 2026-10-07T10:00Z, from Kanban)",
				"QA did not accept your last submission. Fix the blocking issues below in this same worktree, keep what already works, re-run the tests, and leave your changes in the worktree as before (do not commit or cherry-pick into /repos/foo, and do not touch other cards). Then finish exactly like the original task, including its FINAL STEP if it has one. This is rework 2 of at most 2; after 3 failed QA rounds the card goes to a human.",
				"Blocking (from QA):",
				"- cart total wrong",
				"QA details:",
				"- cart total wrong",
				"- see shot.png",
				"QA write-up and artifacts (screenshots, reports) for round 2: .qa/r2/ in your worktree (start with .qa/r2/QA.md). It is git-ignored; leave it there.",
			].join("\n"),
		);
	});

	it("puts the stale-base line first, says how to resolve a conflict, and points at the QA log without staged notes", () => {
		const text = buildReworkText(
			textInput({
				staleBase: { head: "aaaaaaaa1111", tip: "bbbbbbbb2222" },
				conflict: { baseRef: "main", files: ["src/a.ts", "src/b.ts"] },
				stagedNotes: null,
			}),
		);
		expect(text.split("\n")[0]).toMatch(
			/^FIRST bring current main into your worktree .*aaaaaaaa; main is now bbbbbbbb\)/u,
		);
		expect(text).toContain("REWORK round 3 (QA round 2: PASS, but it does not merge;");
		expect(text).toContain("Blocking: rebase onto main: conflicts in src/a.ts, src/b.ts.");
		expect(text).not.toContain("Blocking (from QA)");
		expect(text).toContain(
			'QA write-up: the "## Claude QA d1111 (round 2)" section of /home/data/foo/qa-log.md. QA artifacts (screenshots, reports): /home/data/foo/qa-artifacts/d1111/r2/',
		);
	});

	it("inserts a section before FINAL STEP, or appends it", () => {
		expect(insertBeforeFinalStep("Task\n\n\nFINAL STEP: done", "REWORK")).toBe("Task\n\nREWORK\n\nFINAL STEP: done");
		expect(insertBeforeFinalStep("Task\n", "REWORK")).toBe("Task\n\nREWORK");
	});

	it("reads Blocking bullets in both QA log forms", () => {
		expect(readBlockingBullets("- Blocking: one thing\n  more\n- Visual: ok")).toEqual(["- one thing", "more"]);
		expect(readBlockingBullets("- Visual: ok")).toEqual([]);
	});

	it("slugs model ids for preserve tags and sibling titles", () => {
		expect(modelSlug("us.openai.gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(modelSlug("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5-20251001-v1-0");
		expect(modelSlug(null)).toBe("unknown");
		expect(buildPreserveTag("d1111", "us.moonshot.kimi-k3")).toBe("preserve/d1111-kimi-k3");
	});
});

describe("rework notes in the worktree", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, env: createGitTestEnv(), encoding: "utf8" }).trim();

	const createRepo = () => {
		const temp = createTempDir("kanban-rework-notes-");
		cleanups.push(temp.cleanup);
		const repo = join(temp.path, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "T");
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "a");
		return { root: temp.path, repo };
	};

	it("copies the QA notes into .qa/r<N>/, git-ignored, without HTML or big files", async () => {
		const { root, repo } = createRepo();
		const artifacts = join(root, "artifacts");
		mkdirSync(join(artifacts, "shots"), { recursive: true });
		writeFileSync(join(artifacts, "shots", "cart.png"), "png");
		writeFileSync(join(artifacts, "report.html"), "<html>");
		writeFileSync(join(artifacts, "big.log"), "x".repeat(600 * 1024));

		const rel = await stageQaNotes({
			worktreePath: repo,
			round: 2,
			artifactsDir: artifacts,
			qaSection: "## Claude QA d1111",
		});
		await stageQaNotes({ worktreePath: repo, round: 2, artifactsDir: artifacts, qaSection: "## Claude QA d1111" });

		expect(rel).toBe(".qa/r2");
		expect(readFileSync(join(repo, ".qa/r2/shots/cart.png"), "utf8")).toBe("png");
		expect(existsSync(join(repo, ".qa/r2/report.html"))).toBe(false);
		expect(existsSync(join(repo, ".qa/r2/big.log"))).toBe(false);
		expect(readFileSync(join(repo, ".qa/r2/QA.md"), "utf8")).toBe(
			"## Claude QA d1111\n\nNot copied (HTML or over 512 KB): big.log, report.html\n",
		);
		const exclude = readFileSync(join(repo, ".git/info/exclude"), "utf8");
		expect(exclude.match(/^\/\.qa\/$/gmu)).toHaveLength(1);
		expect(git(repo, "status", "--porcelain")).toBe("");
	});

	it("finds a worktree whose HEAD is behind its base branch", async () => {
		const { root, repo } = createRepo();
		const worktree = join(root, "wt");
		git(repo, "worktree", "add", "-q", "--detach", worktree, "main");
		expect(await readStaleBase({ workspacePath: repo, worktreePath: worktree, baseRef: "main" })).toBeNull();

		writeFileSync(join(repo, "b.txt"), "b\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "b");
		const stale = await readStaleBase({ workspacePath: repo, worktreePath: worktree, baseRef: "main" });
		expect(stale).toEqual({ head: git(worktree, "rev-parse", "HEAD"), tip: git(repo, "rev-parse", "main") });
		expect(await readStaleBase({ workspacePath: repo, worktreePath: worktree, baseRef: "nope" })).toBeNull();
	});
});
