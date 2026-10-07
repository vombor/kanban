import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimeGlobalConfigPath } from "../../../src/config/runtime-config";
import {
	getDebugResetTargetPaths,
	getKanbanHomePath,
	getTaskWorktreeSearchRootPaths,
	resetKanbanHomeForTests,
	resolveKanbanHome,
	setKanbanHomeOverride,
} from "../../../src/state/kanban-home";
import { getTaskWorktreesHomePath, getWorkspacesRootPath } from "../../../src/state/workspace-state";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

describe("kanban home resolution", () => {
	afterEach(() => {
		resetKanbanHomeForTests();
	});

	it("uses ~/.kanban on a fresh install", async () => {
		await withTemporaryKanbanHome((home) => {
			expect(home.source).toBe("default");
			expect(home.homePath).toBe(join(home.userHomePath, ".kanban"));
			expect(home.globalConfigPath).toBe(join(home.userHomePath, ".kanban", "config.json"));
			expect(home.worktreesRootPath).toBe(join(home.userHomePath, ".kanban", "worktrees"));
			expect(home.legacyWorktreeRootPaths).toEqual([join(home.userHomePath, ".cline", "worktrees")]);
		});
	});

	it("keeps the live pod on ~/.cline/kanban while ~/.kanban is the kit repo", async () => {
		// The pod today: an existing legacy home with boards, and ~/.kanban holding the dev-team kit
		// (a git repo with kit.config.json, data/ and logs/, but no config.json "home": 1 and no workspaces/).
		await withTemporaryKanbanHome(
			(home) => {
				const legacyHome = join(home.userHomePath, ".cline", "kanban");
				const legacyWorktrees = join(home.userHomePath, ".cline", "worktrees");
				expect(home.source).toBe("legacy");
				expect(home.homePath).toBe(legacyHome);
				expect(home.globalConfigPath).toBe(join(legacyHome, "config.json"));
				expect(home.worktreesRootPath).toBe(legacyWorktrees);
				expect(home.legacyWorktreeRootPaths).toEqual([]);
				expect(getRuntimeGlobalConfigPath()).toBe(join(legacyHome, "config.json"));
				expect(getWorkspacesRootPath()).toBe(join(legacyHome, "workspaces"));
				expect(getTaskWorktreesHomePath()).toBe(legacyWorktrees);
				expect(getTaskWorktreeSearchRootPaths()).toEqual([legacyWorktrees]);
				expect(getDebugResetTargetPaths()).toEqual([
					join(home.userHomePath, ".cline", "data"),
					legacyHome,
					legacyWorktrees,
				]);
			},
			{
				prepare: (userHomePath) => {
					const legacyHome = join(userHomePath, ".cline", "kanban");
					mkdirSync(join(legacyHome, "workspaces", "foo"), { recursive: true });
					mkdirSync(join(legacyHome, "hooks"), { recursive: true });
					writeJson(join(legacyHome, "config.json"), { selectedAgentId: "claude" });
					mkdirSync(join(userHomePath, ".cline", "worktrees", "d18bd", "kanban"), { recursive: true });
					mkdirSync(join(userHomePath, ".cline", "data"), { recursive: true });
					const kitRepo = join(userHomePath, ".kanban");
					for (const dir of [".git", "data/foo", "logs", "run", "services", "lib", "forks"]) {
						mkdirSync(join(kitRepo, dir), { recursive: true });
					}
					writeJson(join(kitRepo, "kit.config.json"), { workspaces: {} });
				},
			},
		);
	});

	it("does not treat a ~/.kanban/config.json without the home marker as an initialized home", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.source).toBe("legacy");
				expect(home.homePath).toBe(join(home.userHomePath, ".cline", "kanban"));
			},
			{
				layout: "legacy",
				prepare: (userHomePath) => {
					mkdirSync(join(userHomePath, ".kanban"), { recursive: true });
					writeJson(join(userHomePath, ".kanban", "config.json"), { home: 2, pipeline: {} });
				},
			},
		);
	});

	it("prefers an initialized ~/.kanban over the legacy home", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.source).toBe("initialized");
				expect(home.homePath).toBe(join(home.userHomePath, ".kanban"));
				expect(home.worktreesRootPath).toBe(join(home.userHomePath, ".kanban", "worktrees"));
				expect(home.legacyWorktreeRootPaths).toEqual([join(home.userHomePath, ".cline", "worktrees")]);
			},
			{
				layout: "legacy",
				prepare: (userHomePath) => mkdirSync(join(userHomePath, ".kanban", "workspaces"), { recursive: true }),
			},
		);
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.source).toBe("initialized");
				expect(home.homePath).toBe(join(home.userHomePath, ".kanban"));
			},
			{
				layout: "legacy",
				prepare: (userHomePath) => {
					mkdirSync(join(userHomePath, ".kanban"), { recursive: true });
					writeJson(join(userHomePath, ".kanban", "config.json"), { home: 1 });
				},
			},
		);
	});

	it("lets KANBAN_HOME win over the user-home layouts", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.source).toBe("env");
				expect(home.homePath).toBe(join(home.userHomePath, "custom-home"));
				expect(home.worktreesRootPath).toBe(join(home.userHomePath, "custom-home", "worktrees"));
			},
			{ layout: "legacy", env: { KANBAN_HOME: "~/custom-home" } },
		);
	});

	it("lets --home win over KANBAN_HOME and exports it to child processes", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				setKanbanHomeOverride(join(home.userHomePath, "flag-home"));
				expect(resolveKanbanHome().source).toBe("flag");
				expect(getKanbanHomePath()).toBe(join(home.userHomePath, "flag-home"));
				expect(process.env.KANBAN_HOME).toBe(join(home.userHomePath, "flag-home"));
			},
			{ env: { KANBAN_HOME: "/tmp/should-not-be-used" } },
		);
	});

	it("resolves the worktrees root from KANBAN_WORKTREES, then config worktreesRoot", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.worktreesRootPath).toBe(join(home.userHomePath, "env-worktrees"));
			},
			{
				layout: "initialized",
				env: { KANBAN_WORKTREES: "~/env-worktrees" },
				prepare: (userHomePath) =>
					writeJson(join(userHomePath, ".kanban", "config.json"), { worktreesRoot: "~/config-worktrees" }),
			},
		);
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.worktreesRootPath).toBe(join(home.userHomePath, ".kanban", "wt"));
				expect(home.legacyWorktreeRootPaths).toEqual([join(home.userHomePath, "old-a"), "/srv/old-b"]);
			},
			{
				layout: "initialized",
				prepare: (userHomePath) =>
					writeJson(join(userHomePath, ".kanban", "config.json"), {
						worktreesRoot: "wt",
						legacyWorktreeRoots: ["~/old-a", "/srv/old-b", "~/old-a", "wt", 3],
					}),
			},
		);
	});

	it("keeps a resolution stable for the life of the process", async () => {
		await withTemporaryKanbanHome((home) => {
			expect(home.source).toBe("default");
			mkdirSync(join(home.userHomePath, ".cline", "kanban"), { recursive: true });
			expect(resolveKanbanHome().source).toBe("default");
			resetKanbanHomeForTests();
			expect(resolveKanbanHome().source).toBe("legacy");
		});
	});

	it("never offers the user home itself as a debug reset target", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(getDebugResetTargetPaths()).not.toContain(home.userHomePath);
				expect(getDebugResetTargetPaths()).toContain(join(home.userHomePath, "worktrees"));
			},
			{ env: { KANBAN_HOME: "~" } },
		);
	});
});
