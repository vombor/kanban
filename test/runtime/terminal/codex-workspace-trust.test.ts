import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	ensureCodexWorkspaceTrusted,
	getCodexConfigFilePath,
	getCodexWorkspaceTrustLevel,
	hasCodexWorkspaceTrustPrompt,
	shouldAutoConfirmCodexWorkspaceTrust,
} from "../../../src/terminal/codex-workspace-trust";
import { createGitTestEnv } from "../../utilities/git-env";

const originalHome = process.env.HOME;
let tempHome: string | null = null;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-codex-workspace-trust-"));
	process.env.HOME = tempHome;
	return tempHome;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
});

describe("codex workspace trust helpers", () => {
	it("detects Codex trust prompt", () => {
		const codexPrompt = `
You are in /Users/saoud/.cline/worktrees/6df3a/mcp-swift-sdk

Do you trust the contents of this directory? Working with untrusted
contents comes with higher risk of prompt injection.

› 1. Yes, continue
  2. No, quit

Press enter to continue`;
		expect(hasCodexWorkspaceTrustPrompt(codexPrompt)).toBe(true);
	});

	it("detects Codex trust prompt with ANSI formatting", () => {
		const ansiPrompt =
			"Do you trust the \u001b[31mcontents\u001b[0m of this directory? Working with untrusted contents comes with higher risk of prompt injection.";
		expect(hasCodexWorkspaceTrustPrompt(ansiPrompt)).toBe(true);
	});

	it("auto-confirms all codex sessions", () => {
		const home = setupTempHome();
		const taskWorktreePath = join(home, ".cline", "worktrees", "task-123", "context");
		const externalPath = join(home, "projects", "repo");

		expect(shouldAutoConfirmCodexWorkspaceTrust("codex", taskWorktreePath)).toBe(true);
		expect(shouldAutoConfirmCodexWorkspaceTrust("codex", externalPath)).toBe(true);
		expect(shouldAutoConfirmCodexWorkspaceTrust("claude", taskWorktreePath)).toBe(false);
	});
});

describe("codex workspace pre-trust", () => {
	function setupRepoWithWorktree(): { repo: string; worktree: string; configFilePath: string } {
		const home = realpathSync(setupTempHome());
		const repo = join(home, "projects", "app");
		mkdirSync(repo, { recursive: true });
		const env = createGitTestEnv();
		for (const args of [
			["init", "-q"],
			["commit", "-q", "--allow-empty", "-m", "init"],
		]) {
			expect(spawnSync("git", ["-C", repo, ...args], { env }).status).toBe(0);
		}
		const worktree = join(home, "worktrees", "abcde", "app");
		expect(spawnSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", worktree], { env }).status).toBe(0);
		return { repo, worktree, configFilePath: join(home, "config.toml") };
	}

	it("uses CODEX_HOME when set", () => {
		expect(getCodexConfigFilePath({ CODEX_HOME: "/x/codex" })).toBe("/x/codex/config.toml");
	});

	it("appends a trusted entry for the main repo of a worktree, once", async () => {
		const { repo, worktree, configFilePath } = setupRepoWithWorktree();
		const original = 'model = "x"\n\n[projects."/projects/foo"]\ntrust_level = "trusted"\n';
		writeFileSync(configFilePath, original);
		expect(await getCodexWorkspaceTrustLevel(worktree, { configFilePath })).toBeNull();

		expect(await ensureCodexWorkspaceTrusted(worktree, { configFilePath })).toEqual({
			changed: true,
			trustRootPath: repo,
		});
		expect(readFileSync(configFilePath, "utf8")).toBe(`${original}\n[projects."${repo}"]\ntrust_level = "trusted"\n`);
		expect(await getCodexWorkspaceTrustLevel(worktree, { configFilePath })).toBe("trusted");
		expect((await ensureCodexWorkspaceTrusted(repo, { configFilePath })).changed).toBe(false);
	});

	it("leaves an existing different trust level, an inline projects table and a missing file alone", async () => {
		const { repo, configFilePath } = setupRepoWithWorktree();
		writeFileSync(configFilePath, `[projects."${repo}"]\ntrust_level = "untrusted"\n`);
		expect((await ensureCodexWorkspaceTrusted(repo, { configFilePath })).error).toMatch(/untrusted.*left alone/u);

		writeFileSync(configFilePath, 'projects = { "/a" = { trust_level = "trusted" } }\n');
		expect((await ensureCodexWorkspaceTrusted(repo, { configFilePath })).error).toMatch(/inline table/u);
		expect(readFileSync(configFilePath, "utf8")).toBe('projects = { "/a" = { trust_level = "trusted" } }\n');

		const missing = await ensureCodexWorkspaceTrusted(repo, { configFilePath: join(repo, "nope.toml") });
		expect(missing.changed).toBe(false);
		expect(missing.error).toMatch(/does not exist/u);
	});
});

describe("codex workspace pre-trust safety", () => {
	function initRepo(directory: string): void {
		mkdirSync(directory, { recursive: true });
		expect(spawnSync("git", ["-C", directory, "init", "-q"], { env: createGitTestEnv() }).status).toBe(0);
	}

	it("writes exactly one table when several launches pre-trust the same repo at once", async () => {
		const home = realpathSync(setupTempHome());
		const repo = join(home, "projects", "app");
		initRepo(repo);
		const configFilePath = join(home, "config.toml");
		writeFileSync(configFilePath, 'model = "x"\n');

		const results = await Promise.all(
			Array.from({ length: 5 }, () => ensureCodexWorkspaceTrusted(repo, { configFilePath })),
		);

		expect(results.filter((result) => result.changed)).toHaveLength(1);
		expect(results.every((result) => result.error === undefined)).toBe(true);
		expect(readFileSync(configFilePath, "utf8").split(`[projects."${repo}"]`)).toHaveLength(2);
	});

	it("recognises an existing table written with other quoting, spacing or a comment", async () => {
		const home = realpathSync(setupTempHome());
		const repo = join(home, "projects", "app");
		initRepo(repo);
		const configFilePath = join(home, "config.toml");
		for (const header of [`[ projects . '${repo}' ]  # mine`, `[projects."${repo.replaceAll("/", "\\u002F")}"]`]) {
			const original = `${header}\ntrust_level = "trusted"\n`;
			writeFileSync(configFilePath, original);
			expect(await ensureCodexWorkspaceTrusted(repo, { configFilePath })).toEqual({
				changed: false,
				trustRootPath: repo,
			});
			expect(readFileSync(configFilePath, "utf8")).toBe(original);
		}
	});

	it("does not pre-trust a non-git directory, the home directory or a filesystem root", async () => {
		const home = realpathSync(setupTempHome());
		const configFilePath = join(home, ".codex-config.toml");
		writeFileSync(configFilePath, "");
		const plainDir = join(home, "plain");
		mkdirSync(plainDir);
		expect((await ensureCodexWorkspaceTrusted(plainDir, { configFilePath })).error).toMatch(/not inside a git/u);
		expect((await ensureCodexWorkspaceTrusted("/", { configFilePath })).error).toMatch(/not inside a git|root/u);
		initRepo(home);
		expect((await ensureCodexWorkspaceTrusted(home, { configFilePath })).error).toMatch(/home directory/u);
		expect((await ensureCodexWorkspaceTrusted(plainDir, { configFilePath })).error).toMatch(/home directory/u);
		expect(readFileSync(configFilePath, "utf8")).toBe("");
	});
});
