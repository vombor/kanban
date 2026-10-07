// Git reads these to decide which repository, index, object store or ref namespace a command works on. A git hook
// runs with some of them set (GIT_DIR, GIT_INDEX_FILE, GIT_PREFIX, ...), so a git command started from a hook context
// works on the hook's repository instead of its cwd (2026-10-07: tests run by a pre-commit hook set core.bare=true in
// the real repo). See git(1) "ENVIRONMENT VARIABLES" and githooks(5).
export const GIT_REPOSITORY_ENV_NAMES: readonly string[] = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
];

// Repository discovery limits and config files other than the usual ones. Hooks don't set these, a user's shell may
// (GIT_CONFIG_GLOBAL on purpose), so Kanban keeps them; tests drop them too (test/utilities/vitest-setup.ts).
export const GIT_USER_ENV_NAMES: readonly string[] = [
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
];

const GIT_REPOSITORY_ENV_KEYS = new Set(GIT_REPOSITORY_ENV_NAMES);
const GIT_USER_ENV_KEYS = new Set(GIT_USER_ENV_NAMES);
const GIT_CONFIG_ENTRY_ENV_NAME = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

export function isGitRepositoryEnvName(name: string): boolean {
	return GIT_REPOSITORY_ENV_KEYS.has(name);
}

/** The named variables plus the `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` pairs of GIT_CONFIG_COUNT. */
export function isGitUserEnvName(name: string): boolean {
	return GIT_USER_ENV_KEYS.has(name) || GIT_CONFIG_ENTRY_ENV_NAME.test(name);
}

export function createGitProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Prevent parent git hook context from hijacking repository-scoped git commands.
		if (isGitRepositoryEnvName(key)) {
			continue;
		}
		sanitized[key] = value;
	}
	return {
		...sanitized,
		...overrides,
	};
}
