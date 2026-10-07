import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

import { KANBAN_HOME_ENV, KANBAN_WORKTREES_ENV, LEGACY_KIT_ENV_NAMES } from "../../src/state/kanban-home";

// Tests point HOME at temp dirs. An inherited KANBAN_HOME would win over HOME and send their
// writes into the developer's real Kanban home, so it is never inherited. The same goes for the
// legacy kit's KANBAN_KIT_HOME / KIT_CONFIG (doctor and import-kit read the legacy kit's files).
delete process.env[KANBAN_HOME_ENV];
delete process.env[KANBAN_WORKTREES_ENV];
for (const name of LEGACY_KIT_ENV_NAMES) {
	delete process.env[name];
}

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
