import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runKanbanHomeMigration } from "../../src/state/kanban-home-migrate";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function card(id: string) {
	return { id, title: id, prompt: id, baseRef: "main", createdAt: 1, updatedAt: 1 };
}

function session(taskId: string, state: string, workspacePath: string) {
	return {
		taskId,
		state,
		agentId: "claude",
		workspacePath,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
	};
}

function listWorktreePaths(repoPath: string): string[] {
	return runGit(repoPath, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

describe.sequential("kanban home migrate --worktrees", () => {
	it("moves worktrees of idle cards only, fixes git metadata and the session paths", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const legacyHome = join(userHomePath, ".cline", "kanban");
				const legacyWorktrees = join(userHomePath, ".cline", "worktrees");
				const targetHome = join(userHomePath, ".kanban");
				const repoPath = join(userHomePath, "projects", "app");
				mkdirSync(repoPath, { recursive: true });
				runGit(repoPath, ["init", "-b", "main"]);
				writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
				runGit(repoPath, ["add", "."]);
				runGit(repoPath, ["commit", "-m", "init"]);

				// One worktree per card: backlog and done are idle; in_progress and review are live; the
				// backlog card "busy" still has a running session.
				const tasks = {
					idle1: "backlog",
					done1: "trash",
					live1: "in_progress",
					review1: "review",
					busy1: "backlog",
					locked1: "backlog",
				} as const;
				const legacyPath = (taskId: string) => join(legacyWorktrees, taskId, "app");
				for (const taskId of Object.keys(tasks)) {
					mkdirSync(dirname(legacyPath(taskId)), { recursive: true });
					runGit(repoPath, ["worktree", "add", "--detach", legacyPath(taskId), "main"]);
				}
				writeFileSync(join(legacyPath("idle1"), "wip.txt"), "uncommitted work\n", "utf8");
				runGit(repoPath, ["worktree", "lock", "--reason", "on a usb disk", legacyPath("locked1")]);

				writeJson(join(legacyHome, "config.json"), { selectedAgentId: "claude" });
				writeJson(join(legacyHome, "workspaces", "index.json"), {
					version: 1,
					entries: { app: { workspaceId: "app", repoPath } },
					repoPathToId: { [repoPath]: "app" },
				});
				const columnIds = ["backlog", "in_progress", "review", "trash"];
				writeJson(join(legacyHome, "workspaces", "app", "board.json"), {
					columns: columnIds.map((id) => ({
						id,
						title: id,
						cards: Object.entries(tasks)
							.filter(([, columnId]) => columnId === id)
							.map(([taskId]) => card(taskId)),
					})),
					dependencies: [],
				});
				writeJson(join(legacyHome, "workspaces", "app", "sessions.json"), {
					idle1: session("idle1", "idle", legacyPath("idle1")),
					live1: session("live1", "running", legacyPath("live1")),
					busy1: session("busy1", "running", legacyPath("busy1")),
				});

				const dryRun = await runKanbanHomeMigration({
					toPath: targetHome,
					dryRun: true,
					moveWorktrees: true,
					probeRuntimeServer: async () => null,
				});
				const actions = Object.fromEntries(dryRun.plan.worktrees.map((step) => [step.taskId, step.action]));
				expect(actions).toEqual({
					idle1: "move",
					done1: "move",
					live1: "skip",
					review1: "skip",
					busy1: "skip",
					locked1: "skip",
				});
				expect(dryRun.plan.worktrees.find((step) => step.taskId === "locked1")?.reason).toBe(
					"worktree is locked (git worktree lock)",
				);
				expect(existsSync(targetHome)).toBe(false);

				const result = await runKanbanHomeMigration({
					toPath: targetHome,
					moveWorktrees: true,
					probeRuntimeServer: async () => null,
				});
				expect(result.plan.blockers).toEqual([]);
				expect(result.worktrees.filter((step) => step.error)).toEqual([]);

				const newPath = (taskId: string) => join(targetHome, "worktrees", taskId, "app");
				expect(new Set(listWorktreePaths(repoPath))).toEqual(
					new Set([
						repoPath,
						newPath("idle1"),
						newPath("done1"),
						legacyPath("live1"),
						legacyPath("review1"),
						legacyPath("busy1"),
						legacyPath("locked1"),
					]),
				);
				// The moved worktree is intact, uncommitted work included, and git still knows it.
				expect(readFileSync(join(newPath("idle1"), "wip.txt"), "utf8")).toBe("uncommitted work\n");
				expect(runGit(newPath("idle1"), ["status", "--porcelain"])).toBe("?? wip.txt");
				expect(existsSync(join(legacyWorktrees, "idle1"))).toBe(false);
				// Live worktrees are untouched.
				expect(existsSync(join(legacyPath("live1"), "README.md"))).toBe(true);

				const targetSessions = JSON.parse(
					readFileSync(join(targetHome, "workspaces", "app", "sessions.json"), "utf8"),
				) as Record<string, { workspacePath: string }>;
				expect(targetSessions.idle1?.workspacePath).toBe(newPath("idle1"));
				expect(targetSessions.live1?.workspacePath).toBe(legacyPath("live1"));
				// The source home keeps its own records.
				const sourceSessions = JSON.parse(
					readFileSync(join(legacyHome, "workspaces", "app", "sessions.json"), "utf8"),
				) as Record<string, { workspacePath: string }>;
				expect(sourceSessions.idle1?.workspacePath).toBe(legacyPath("idle1"));

				// A re-run moves nothing new.
				const again = await runKanbanHomeMigration({
					toPath: targetHome,
					moveWorktrees: true,
					probeRuntimeServer: async () => null,
				});
				expect(again.plan.worktrees.filter((step) => step.action !== "skip")).toEqual([]);
				expect(again.plan.upToDate).toBe(true);
				// The rewritten session paths are the migration's own work, not a newer board.
				expect(again.plan.files).toContainEqual({
					path: join("workspaces", "app", "sessions.json"),
					kind: "file",
					action: "unchanged",
				});

				// An interrupted run: the worktree moved, but the session record was not rewritten yet.
				const sessionsPath = join(targetHome, "workspaces", "app", "sessions.json");
				writeJson(sessionsPath, { ...targetSessions, idle1: session("idle1", "idle", legacyPath("idle1")) });
				const resumed = await runKanbanHomeMigration({
					toPath: targetHome,
					moveWorktrees: true,
					probeRuntimeServer: async () => null,
				});
				expect(resumed.plan.upToDate).toBe(false);
				expect(
					resumed.plan.worktrees.filter((step) => step.action === "relink").map((step) => step.taskId),
				).toEqual(["idle1"]);
				const relinked = JSON.parse(readFileSync(sessionsPath, "utf8")) as Record<
					string,
					{ workspacePath: string }
				>;
				expect(relinked.idle1?.workspacePath).toBe(newPath("idle1"));
			},
			{ layout: "legacy" },
		);
	});

	it("leaves every worktree in place without --worktrees", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const legacyHome = join(userHomePath, ".cline", "kanban");
				writeJson(join(legacyHome, "config.json"), {});
				const result = await runKanbanHomeMigration({
					toPath: join(userHomePath, ".kanban"),
					probeRuntimeServer: async () => null,
				});
				expect(result.executed).toBe(true);
				expect(result.plan.worktrees).toEqual([]);
				expect(existsSync(join(userHomePath, ".kanban", "worktrees"))).toBe(false);
			},
			{ layout: "legacy" },
		);
	});
});
