import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GIT_REPOSITORY_ENV_NAMES, GIT_USER_ENV_NAMES } from "../../src/core/git-process-env";
import { createGitTestEnv, scrubGitEnvironment } from "../utilities/git-env";
import { createRepoWithWorktree, git } from "../utilities/git-repo";

const repoRoot = resolve(__dirname, "../..");

// On 2026-10-07 the pre-commit hook ran the tests with GIT_DIR / GIT_INDEX_FILE set, and the temp-repo git commands
// set core.bare=true, committed and added worktrees in the real repo. These tests point those variables at a fake repo.
describe("git environment isolation", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function createFakeRepo() {
		const fake = createRepoWithWorktree("kanban-fake-hook-repo-");
		cleanups.push(fake.cleanup);
		const gitDir = join(fake.repoPath, ".git");
		const read = () => ({
			config: readFileSync(join(gitDir, "config"), "utf8"),
			index: readFileSync(join(gitDir, "index")).toString("base64"),
			refs: git(fake.repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"]),
			worktrees: git(fake.repoPath, ["worktree", "list", "--porcelain"]),
		});
		return { ...fake, gitDir, read };
	}

	it("scrubs repository and config redirection, including GIT_CONFIG_KEY_<n> pairs", () => {
		const env: NodeJS.ProcessEnv = {
			GIT_DIR: "/fake/.git",
			GIT_INDEX_FILE: "/fake/.git/index",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.bare",
			GIT_CONFIG_VALUE_0: "true",
			GIT_AUTHOR_NAME: "kept",
			PATH: "/usr/bin",
		};
		expect(scrubGitEnvironment(env)).toEqual([
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"GIT_DIR",
			"GIT_INDEX_FILE",
		]);
		expect(env).toEqual({ GIT_AUTHOR_NAME: "kept", PATH: "/usr/bin" });
	});

	it("the test setup leaves no hook variable and gives git a temp global config", () => {
		for (const name of [...GIT_REPOSITORY_ENV_NAMES, "GIT_CONFIG", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT"]) {
			expect(process.env[name], name).toBeUndefined();
		}
		expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
		expect(createGitTestEnv().GIT_CONFIG_GLOBAL).toBe(process.env.GIT_CONFIG_GLOBAL);
	});

	it("a vitest run started with GIT_DIR / GIT_INDEX_FILE on a fake repo leaves that repo untouched", () => {
		const fake = createFakeRepo();
		const before = fake.read();
		// What a hook's child sees: this run's own git config isolation dropped, the hook's repository variables set.
		const hookEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
		scrubGitEnvironment(hookEnv);
		Object.assign(hookEnv, {
			GIT_DIR: fake.gitDir,
			GIT_INDEX_FILE: join(fake.gitDir, "index"),
			GIT_WORK_TREE: fake.repoPath,
			GIT_PREFIX: "",
		});

		const result = spawnSync(
			process.execPath,
			[
				join(repoRoot, "node_modules/vitest/vitest.mjs"),
				"run",
				"--config",
				"test/fixtures/git-env-leak/vitest.config.ts",
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: hookEnv,
			},
		);

		const output = `${result.stdout}\n${result.stderr}`;
		expect(result.status, output).toBe(0);
		expect(output).toContain(
			"removed inherited git environment variables: GIT_DIR, GIT_INDEX_FILE, GIT_PREFIX, GIT_WORK_TREE",
		);
		expect(fake.read()).toEqual(before);
		expect(git(fake.repoPath, ["config", "--get", "core.bare"])).toBe("false");
	}, 120_000);

	it(".husky/pre-commit unsets every variable the tests scrub", () => {
		const hook = readFileSync(join(repoRoot, ".husky/pre-commit"), "utf8");
		const unsetLine = hook.slice(hook.indexOf("unset_git_environment() {"), hook.indexOf("for name in"));
		for (const name of [...GIT_REPOSITORY_ENV_NAMES, ...GIT_USER_ENV_NAMES]) {
			expect(unsetLine, name).toMatch(new RegExp(`\\b${name}\\b`));
		}
		expect(hook).toContain("GIT_CONFIG_KEY_");
		expect(hook).toContain("GIT_CONFIG_VALUE_");
	});
});
