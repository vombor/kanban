import { tmpdir } from "node:os";

import { isGitRepositoryEnvName, isGitUserEnvName } from "../../src/core/git-process-env";

/**
 * Deletes, in place, every variable that sends git to another repository, index, object store or config (git hooks
 * export GIT_DIR, GIT_INDEX_FILE, ...: on 2026-10-07 tests run by a pre-commit hook set core.bare=true in the real
 * repo). Returns the names it deleted.
 */
export function scrubGitEnvironment(env: NodeJS.ProcessEnv): string[] {
	const removed = Object.keys(env).filter((name) => isGitRepositoryEnvName(name) || isGitUserEnvName(name));
	for (const name of removed) {
		delete env[name];
	}
	return removed.sort();
}

/** No system config, and a global config file of the test run's own (set by test/utilities/vitest-setup.ts). */
export function isolateGitConfig(env: NodeJS.ProcessEnv, globalConfigPath: string): void {
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = globalConfigPath;
}

function readIsolatedGitConfigEnv(): NodeJS.ProcessEnv {
	const globalConfigPath = process.env.GIT_CONFIG_GLOBAL;
	if (!globalConfigPath?.startsWith(tmpdir())) {
		return {};
	}
	return { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfigPath };
}

export function createGitTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Hooks can export GIT_* vars that redirect git commands away from test cwd.
		if (key.startsWith("GIT_")) {
			continue;
		}
		sanitized[key] = value;
	}
	return {
		...sanitized,
		...readIsolatedGitConfigEnv(),
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@test.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@test.com",
		...overrides,
	};
}
