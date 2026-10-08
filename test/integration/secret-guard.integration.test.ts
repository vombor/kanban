import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const REPO_ROOT = resolve(__dirname, "../..");
const GUARD = join(REPO_ROOT, "scripts/secret-guard.sh");
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
		// No GitHub PAT from this machine either.
		const home = join(tempDir.path, "home");
		mkdirSync(home);
		env = createGitTestEnv({
			HOME: home,
			KANBAN_HOME: join(home, ".kanban"),
			SECRET_GUARD: "on",
			GH_TOKEN: "",
			GITHUB_TOKEN: "",
			COPILOT_GITHUB_TOKEN: "",
			AWS_BEARER_TOKEN_BEDROCK: "",
		});
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

	it("knows the GitHub PAT from GH_TOKEN as a secret value, without printing it", () => {
		// Not key-shaped on purpose: only the env value can make this a hit.
		const pat = "plain-pat-value-1234567890";
		const commit = commitFile("notes.txt", `token: ${pat}\n`, "notes");
		env = { ...env, GH_TOKEN: pat };

		const result = runGuard(["--scan", "HEAD"]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`commit ${commit.slice(0, 10)} adds a secret value used on this machine`);
		expect(result.stderr).not.toContain(pat);
	});

	it("knows Copilot's token from COPILOT_GITHUB_TOKEN as a secret value", () => {
		const token = "plain-copilot-value-1234567890";
		const commit = commitFile("copilot.txt", `copilot: ${token}\n`, "copilot");
		env = { ...env, COPILOT_GITHUB_TOKEN: token };

		const result = runGuard(["--scan", "HEAD"]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`commit ${commit.slice(0, 10)} adds a secret value used on this machine`);
		expect(result.stderr).not.toContain(token);
	});

	it("knows the Bedrock key from AWS_BEARER_TOKEN_BEDROCK as a secret value", () => {
		const key = "plain-bedrock-value-1234567890";
		const commit = commitFile("bedrock.txt", `key: ${key}\n`, "bedrock");
		env = { ...env, AWS_BEARER_TOKEN_BEDROCK: key };

		const result = runGuard(["--scan", "HEAD"]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`commit ${commit.slice(0, 10)} adds a secret value used on this machine`);
		expect(result.stderr).not.toContain(key);
	});

	it("keeps added lines that start with ++ and scans root commits", () => {
		const root = commitFile("root.txt", `++${FAKE_AWS_KEY}\n`, "root");

		const result = runGuard(["--scan", "HEAD"]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`commit ${root.slice(0, 10)} adds key-shaped string`);
	});
});

// The guard's own key-shape pattern (its `pattern='...'` line), so this check and the guard can't drift apart.
function readGuardKeyPattern(): RegExp {
	const match = /^pattern='(.+)'$/m.exec(readFileSync(GUARD, "utf8"));
	if (!match?.[1]) {
		throw new Error(`no pattern='...' line in ${GUARD}`);
	}
	return new RegExp(match[1], "m");
}

// Walks the file system, not `git ls-files`: the pipeline's checks run this suite on a `git archive` export.
function listTestFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : listTestFiles(path);
		}
		return entry.isFile() ? [path] : [];
	});
}

describe("repo test files", () => {
	it("hold no literal the guard would block (assemble a key-shaped fixture at run time)", () => {
		const pattern = readGuardKeyPattern();
		const files = [
			...listTestFiles(join(REPO_ROOT, "test")),
			...listTestFiles(join(REPO_ROOT, "web-ui/src")).filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path)),
			...listTestFiles(join(REPO_ROOT, "web-ui/tests")),
		];

		const hits = files
			.filter((path) => pattern.test(readFileSync(path, "utf8")))
			.map((path) => relative(REPO_ROOT, path));

		expect(files.length).toBeGreaterThan(0);
		expect(hits).toEqual([]);
	});
});
