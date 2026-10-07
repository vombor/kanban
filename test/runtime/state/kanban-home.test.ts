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

	it("uses ~/.kanban on a fresh install, with no legacy worktree roots", async () => {
		await withTemporaryKanbanHome((home) => {
			expect(home.source).toBe("default");
			expect(home.homePath).toBe(join(home.userHomePath, ".kanban"));
			expect(home.globalConfigPath).toBe(join(home.userHomePath, ".kanban", "config.json"));
			expect(home.worktreesRootPath).toBe(join(home.userHomePath, ".kanban", "worktrees"));
			expect(home.legacyWorktreeRootPaths).toEqual([]);
			expect(getTaskWorktreeSearchRootPaths()).toEqual([join(home.userHomePath, ".kanban", "worktrees")]);
		});
	});

	it("never uses a home under ~/.cline, with or without an initialized ~/.kanban", async () => {
		const prepareOldHome = (userHomePath: string) => {
			const oldHome = join(userHomePath, ".cline", "kanban");
			mkdirSync(join(oldHome, "workspaces", "foo"), { recursive: true });
			writeJson(join(oldHome, "config.json"), { selectedAgentId: "claude" });
			mkdirSync(join(userHomePath, ".cline", "worktrees", "d18bd", "kanban"), { recursive: true });
		};
		await withTemporaryKanbanHome(
			(home) => {
				const kanbanHome = join(home.userHomePath, ".kanban");
				expect(home.source).toBe("default");
				expect(home.homePath).toBe(kanbanHome);
				expect(home.legacyWorktreeRootPaths).toEqual([]);
				expect(getRuntimeGlobalConfigPath()).toBe(join(kanbanHome, "config.json"));
				expect(getWorkspacesRootPath()).toBe(join(kanbanHome, "workspaces"));
				expect(getTaskWorktreesHomePath()).toBe(join(kanbanHome, "worktrees"));
			},
			{ prepare: prepareOldHome },
		);
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.source).toBe("default");
				expect(home.homePath).toBe(join(home.userHomePath, ".kanban"));
			},
			{ layout: "initialized", prepare: prepareOldHome },
		);
	});

	it("honours an explicit legacyWorktreeRoots entry (a home move's leftovers) read-only", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				const oldRoot = join(home.userHomePath, "old-worktrees");
				expect(home.worktreesRootPath).toBe(join(home.userHomePath, ".kanban", "worktrees"));
				expect(home.legacyWorktreeRootPaths).toEqual([oldRoot]);
				expect(getTaskWorktreeSearchRootPaths()).toEqual([
					join(home.userHomePath, ".kanban", "worktrees"),
					oldRoot,
				]);
			},
			{
				layout: "initialized",
				prepare: (userHomePath) =>
					writeJson(join(userHomePath, ".kanban", "config.json"), {
						home: 1,
						legacyWorktreeRoots: ["~/old-worktrees"],
					}),
			},
		);
	});

	it("lets KANBAN_HOME win over ~/.kanban", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(home.source).toBe("env");
				expect(home.homePath).toBe(join(home.userHomePath, "custom-home"));
				expect(home.worktreesRootPath).toBe(join(home.userHomePath, "custom-home", "worktrees"));
				expect(home.legacyWorktreeRootPaths).toEqual([]);
			},
			{ layout: "initialized", env: { KANBAN_HOME: "~/custom-home" } },
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

	it("does not switch homes when a directory appears", async () => {
		await withTemporaryKanbanHome((home) => {
			mkdirSync(join(home.userHomePath, ".cline", "kanban", "workspaces"), { recursive: true });
			resetKanbanHomeForTests();
			expect(resolveKanbanHome()).toMatchObject({ source: "default", homePath: join(home.userHomePath, ".kanban") });
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
