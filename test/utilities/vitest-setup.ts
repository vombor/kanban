import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

import { KANBAN_HOME_ENV, KANBAN_WORKTREES_ENV, LEGACY_KIT_ENV_NAMES } from "../../src/state/kanban-home";
import { isolateGitConfig, scrubGitEnvironment } from "./git-env";

// Tests point HOME at temp dirs. An inherited KANBAN_HOME would win over HOME and send their
// writes into the developer's real Kanban home, so it is never inherited. The same goes for the
// legacy kit's KANBAN_KIT_HOME / KIT_CONFIG (doctor and import-kit read the legacy kit's files).
delete process.env[KANBAN_HOME_ENV];
delete process.env[KANBAN_WORKTREES_ENV];
for (const name of LEGACY_KIT_ENV_NAMES) {
	delete process.env[name];
}

// A git hook runs with GIT_DIR / GIT_INDEX_FILE (and more) set, so tests run by the pre-commit hook sent every
// temp-repo git command to the real repo (2026-10-07: core.bare=true, commits and worktrees in /projects/kanban).
// vitest-global-setup.ts scrubs and reports them once; this repeats it for each test file, so even a git command
// spawned with the inherited process.env works on its cwd, and gives git an empty global config and no system one.
scrubGitEnvironment(process.env);
const gitConfigDir = mkdtempSync(join(tmpdir(), "kanban-test-git-config-"));
const gitGlobalConfigPath = join(gitConfigDir, "gitconfig");
writeFileSync(gitGlobalConfigPath, "");
isolateGitConfig(process.env, gitGlobalConfigPath);
afterAll(() => {
	rmSync(gitConfigDir, { recursive: true, force: true });
});

// A run without HOME=<temp dir> resolved the real Kanban home: pipeline-worker tests with the team kit's default
// features appended 392 test lines to foo's live data/foo/scoreboard.jsonl (2026-10-07). So a HOME outside the temp
// dir is replaced with a fresh one per test file.
if (!process.env.HOME?.startsWith(tmpdir())) {
	const testHome = mkdtempSync(join(tmpdir(), "kanban-test-home-"));
	process.env.HOME = testHome;
	process.env.USERPROFILE = testHome;
	afterAll(() => {
		rmSync(testHome, { recursive: true, force: true });
	});
}
