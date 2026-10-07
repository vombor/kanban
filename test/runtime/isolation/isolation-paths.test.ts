// What a launch denies under project isolation (src/isolation/isolation-paths.ts), from kanban-home.ts paths only.
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import {
	buildIsolationPromptNote,
	listIsolationReadDenied,
	listIsolationWriteDenied,
	resolveSessionIsolation,
} from "../../../src/isolation/isolation-paths";
import { getKanbanGlobalConfigPath, getKanbanWorkspaceDataPath } from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const ENTRIES = [
	{ workspaceId: "a", repoPath: "/nonexistent/projects/a" },
	{ workspaceId: "b", repoPath: "/nonexistent/projects/b" },
	{ workspaceId: "c", repoPath: "/nonexistent/projects/c" },
];
const WORKTREES: Record<string, string[]> = {
	"/nonexistent/projects/a": ["/nonexistent/projects/a", "/nonexistent/wt/a1/a"],
	"/nonexistent/projects/b": ["/nonexistent/projects/b", "/nonexistent/wt/b1/b"],
	"/nonexistent/projects/c": ["/nonexistent/projects/c"],
};

async function resolve(raw: Record<string, unknown>, granted: string[] = []) {
	return await resolveSessionIsolation({
		config: parsePipelineConfig(raw).config,
		workspaceId: "a",
		projectPath: "/nonexistent/projects/a",
		entries: ENTRIES,
		grantedWorkspaceIds: granted,
		listWorktrees: async (repoPath) => WORKTREES[repoPath] ?? [],
	});
}

describe("resolveSessionIsolation", () => {
	it("is null while isolation is off (no git calls, launch unchanged)", async () => {
		await withTemporaryKanbanHome(async () => {
			expect(await resolve({})).toBeNull();
			expect(await resolve({ isolation: { mode: "report" } })).toBeNull();
		});
	});

	it("denies the other projects' checkouts, worktrees and data, never its own", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const isolation = await resolve({ isolation: { mode: "enforce" } });
			expect(isolation).not.toBeNull();
			const denied = isolation?.deniedDirs ?? [];
			expect(denied).toEqual(
				expect.arrayContaining([
					"/nonexistent/projects/b",
					"/nonexistent/wt/b1/b",
					"/nonexistent/projects/c",
					getKanbanWorkspaceDataPath("b"),
					getKanbanWorkspaceDataPath("c"),
				]),
			);
			expect(denied.some((path) => path.includes("projects/a") || path.endsWith("/a1/a"))).toBe(false);
			expect(denied).not.toContain(getKanbanWorkspaceDataPath("a"));
			expect(isolation?.dataDir).toBe(getKanbanWorkspaceDataPath("a"));
			expect(isolation?.claudeProjectDirs).toContain(
				join(userHomePath, ".claude", "projects", "-nonexistent-projects-b"),
			);
			if (isolation) {
				expect(listIsolationWriteDenied(isolation)).toContain(getKanbanGlobalConfigPath());
				expect(listIsolationReadDenied(isolation)).not.toContain(getKanbanGlobalConfigPath());
			}
		});
	});

	it("leaves out granted projects, and protects an enforced project from a workspace that is off", async () => {
		await withTemporaryKanbanHome(async () => {
			const granted = await resolve({ isolation: { mode: "enforce" } }, ["b"]);
			expect(granted?.deniedDirs).not.toContain("/nonexistent/projects/b");
			expect(granted?.deniedDirs).toContain("/nonexistent/projects/c");
			const protectedOnly = await resolve({ workspaces: { c: { isolation: { mode: "enforce" } } } });
			expect(protectedOnly?.deniedDirs).toContain("/nonexistent/projects/c");
			expect(protectedOnly?.deniedDirs).not.toContain("/nonexistent/projects/b");
		});
	});

	it("follows a home move: data and config paths come from KANBAN_HOME", async () => {
		await withTemporaryKanbanHome(
			async ({ homePath }) => {
				const isolation = await resolve({ isolation: { mode: "enforce" } });
				expect(isolation?.dataDir.startsWith(homePath)).toBe(true);
				expect(isolation?.machineConfigPaths).toContain(join(homePath, "config.json"));
			},
			{ env: { KANBAN_HOME: "/nonexistent/moved-home" } },
		);
	});

	it("the prompt note names only the session's own project", async () => {
		await withTemporaryKanbanHome(async () => {
			const isolation = await resolve({ isolation: { mode: "enforce" } });
			const note = isolation ? buildIsolationPromptNote(isolation, ["reads of other projects"]) : "";
			expect(note).toContain("/nonexistent/projects/a");
			expect(note).not.toContain("projects/b");
			expect(note).toContain("Not blocked for you (reads of other projects)");
		});
	});
});
