import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const GUARD = resolve(__dirname, "../../scripts/secret-guard.sh");
const ZERO_SHA = "0".repeat(40);
// Built at run time so this file never contains a key-shaped string itself (the guard would block its push).
const FAKE_AWS_KEY = `AKIA${"Q".repeat(16)}`;

let tempDir: { path: string; cleanup: () => void };
let repo: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = repo): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function commitFile(file: string, content: string, message: string): string {
	writeFileSync(join(repo, file), content, "utf8");
	git(["add", file]);
	git(["commit", "-qm", message]);
	return git(["rev-parse", "HEAD"]);
}

function runGuard(args: string[], input?: string): { status: number | null; stderr: string } {
	const result = spawnSync("bash", [GUARD, ...args], { cwd: repo, encoding: "utf8", env, input });
	return { status: result.status, stderr: result.stderr };
}

// base -> (main, feature) -> merge. The merge itself adds secret.txt (an "evil" merge: the key is in no parent).
function createMergeAddingKey(secretContent: string): string {
	commitFile("base.txt", "base\n", "base");
	git(["checkout", "-qb", "feature"]);
	commitFile("feature.txt", "feature\n", "feature");
	git(["checkout", "-q", "main"]);
	commitFile("main.txt", "main\n", "main");
	git(["merge", "--no-ff", "--no-commit", "-q", "feature"]);
	writeFileSync(join(repo, "secret.txt"), secretContent, "utf8");
	git(["add", "secret.txt"]);
	git(["commit", "-qm", "merge feature"]);
	return git(["rev-parse", "HEAD"]);
}

describe.sequential("scripts/secret-guard.sh", () => {
	beforeEach(() => {
		tempDir = createTempDir("kanban-secret-guard-");
		// An empty HOME and KANBAN_HOME: the guard must never read this machine's real credential files in tests.
		const home = join(tempDir.path, "home");
		mkdirSync(home);
		env = createGitTestEnv({ HOME: home, KANBAN_HOME: join(home, ".kanban"), SECRET_GUARD: "on" });
		repo = join(tempDir.path, "repo");
		mkdirSync(repo);
		git(["init", "-q", "-b", "main"]);
	});

	afterEach(() => {
		tempDir.cleanup();
	});

	it("passes clean history, including a merge and a token-internal sk- string", () => {
		commitFile("a.ts", 'import "./task-agent-settings-fields";\n', "clean");
		createMergeAddingKey("nothing secret here\n");

		const result = runGuard(["--scan", "HEAD"]);

		expect(result.stderr).toContain("5 commits scanned, clean");
		expect(result.status).toBe(0);
	});

	it("finds a key-shaped token that only a merge commit adds", () => {
		const merge = createMergeAddingKey(`aws = "${FAKE_AWS_KEY}"\n`);

		const result = runGuard(["--scan", "HEAD"]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`commit ${merge.slice(0, 10)} adds key-shaped string`);
		expect(result.stderr).toContain("secret.txt");
		expect(result.stderr).not.toContain(FAKE_AWS_KEY);
	});

	it("blocks a pre-push of a branch whose merge commit adds a key", () => {
		const remote = join(tempDir.path, "remote.git");
		git(["init", "-q", "--bare", remote], tempDir.path);
		git(["remote", "add", "origin", remote]);
		commitFile("seed.txt", "seed\n", "seed");
		git(["push", "-q", "origin", "main"]);
		git(["fetch", "-q", "origin"]);
		const merge = createMergeAddingKey(`${FAKE_AWS_KEY}\n`);

		const result = runGuard(["origin", remote], `refs/heads/main ${merge} refs/heads/main ${ZERO_SHA}\n`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`BLOCKED push of main: commit ${merge.slice(0, 10)}`);
	});

	it("keeps added lines that start with ++ and scans root commits", () => {
		const root = commitFile("root.txt", `++${FAKE_AWS_KEY}\n`, "root");

		const result = runGuard(["--scan", "HEAD"]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`commit ${root.slice(0, 10)} adds key-shaped string`);
	});
});
