// The Kanban CLI inside an agent session (src/isolation/cli-scope.ts): user-only and machine-wide commands, and the
// in-process board-file scope (workspace-state.ts setWorkspaceAccessGuard).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyCliSessionScope } from "../../../src/isolation/cli-scope";
import { KANBAN_SESSION_CREDENTIAL_ENV, KANBAN_SESSION_WORKSPACE_ENV } from "../../../src/isolation/session-identity";
import { getKanbanGlobalConfigPath } from "../../../src/state/kanban-home";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	loadWorkspaceContextById,
	setWorkspaceAccessGuard,
} from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

const SESSION_ENV = { [KANBAN_SESSION_CREDENTIAL_ENV]: "c".repeat(64) };

afterEach(() => {
	setWorkspaceAccessGuard(null);
});

function writeConfig(config: Record<string, unknown>): void {
	mkdirSync(join(getKanbanGlobalConfigPath(), ".."), { recursive: true });
	writeFileSync(getKanbanGlobalConfigPath(), JSON.stringify(config));
}

const down = async () => Promise.reject(new Error("down"));
const noServer = () => ({
	isolation: { whoami: { query: vi.fn(down) }, requestApproval: { mutate: vi.fn(down) } },
});

describe("applyCliSessionScope", () => {
	it("does nothing outside an agent session, and never scopes the hook commands", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({ isolation: { mode: "report" } });
			for (const commandPath of ["project add", "task list", "kit apply"]) {
				expect(
					await applyCliSessionScope({ commandPath, options: {}, createClient: noServer as never, env: {} }),
				).toBeNull();
			}
			writeConfig({ isolation: { mode: "enforce" } });
			expect(
				await applyCliSessionScope({
					commandPath: "task list",
					options: {},
					createClient: noServer as never,
					env: {},
				}),
			).toBeNull();
			expect(
				await applyCliSessionScope({
					commandPath: "hooks ingest",
					options: {},
					createClient: noServer as never,
					env: SESSION_ENV,
				}),
			).toBeNull();
		});
	});

	it("under enforce, the user's project add/create waits for the console code (and can't go ahead without a server)", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({ workspaces: { a: { isolation: { mode: "enforce" } } } });
			expect(
				await applyCliSessionScope({
					commandPath: "project add",
					options: {},
					createClient: noServer as never,
					env: {},
				}),
			).toContain("could not be reached");
			const approve = vi.fn(async (input: { id: string; code: string }) =>
				input.code === "GOODCODE" ? { ok: true, result: "approved" } : { ok: false, result: null, error: "wrong" },
			);
			const client = {
				isolation: {
					requestApproval: { mutate: vi.fn(async () => ({ ok: true, approvalId: "a-1", required: true })) },
					approve: { mutate: approve },
					approvalStatus: { query: vi.fn(async () => ({ approval: { status: "pending" } })) },
				},
			};
			const codes = ["BADCODE", "GOODCODE"];
			const run = async () =>
				await applyCliSessionScope({
					commandPath: "project create",
					options: {},
					args: ["/projects/new"],
					createClient: () => client as never,
					env: {},
					approval: { readCode: async () => codes.shift() ?? null, write: () => {} },
				});
			expect(await run()).toBeNull();
			expect(client.isolation.requestApproval.mutate).toHaveBeenCalledWith({
				kind: "project.create",
				summary: "project create /projects/new",
			});
			expect(approve).toHaveBeenCalledTimes(2);
			expect(await run()).toContain("not approved");
		});
	});

	it("refuses project add/create, grants, approvals and Cline writes from a session whatever the mode", async () => {
		await withTemporaryKanbanHome(async () => {
			for (const commandPath of [
				"project add",
				"project create",
				"isolation grant",
				"isolation approve",
				"cline apply-lemonade-models",
			]) {
				expect(
					await applyCliSessionScope({
						commandPath,
						options: {},
						createClient: noServer as never,
						env: SESSION_ENV,
					}),
				).toContain("is the user's");
			}
		});
	});

	it("refuses machine-wide commands under enforce only; doctor without --fix stays allowed", async () => {
		await withTemporaryKanbanHome(async () => {
			const env = { ...SESSION_ENV, [KANBAN_SESSION_WORKSPACE_ENV]: "a" };
			const run = async (commandPath: string, options: Record<string, unknown> = {}) =>
				await applyCliSessionScope({ commandPath, options, createClient: noServer as never, env });
			writeConfig({});
			expect(await run("kit apply")).toBeNull();
			expect(await run("doctor", { fix: true })).toBeNull();
			writeConfig({ workspaces: { a: { isolation: { mode: "enforce" } } } });
			expect(await run("kit apply")).toContain("machine-wide");
			expect(await run("config import-kit")).toContain("machine-wide");
			expect(await run("doctor", { fix: true })).toContain("doctor --fix");
			expect(await run("doctor")).toBeNull();
		});
	});
});

describe("the in-process board scope", () => {
	function initRepo(path: string): void {
		mkdirSync(path, { recursive: true });
		spawnSync("git", ["init", "-q", path], { env: createGitTestEnv() });
	}

	it("hides and refuses other workspaces under enforce and refuses registering a new project", async () => {
		await withTemporaryKanbanHome(async () => {
			const root = createTempDir("kanban-cli-scope-");
			try {
				const repoA = join(root.path, "a");
				const repoB = join(root.path, "b");
				const repoNew = join(root.path, "new");
				for (const repo of [repoA, repoB, repoNew]) {
					initRepo(repo);
				}
				const a = await loadWorkspaceContext(repoA);
				const b = await loadWorkspaceContext(repoB);
				writeConfig({ isolation: { mode: "enforce" } });
				const env = { ...SESSION_ENV, [KANBAN_SESSION_WORKSPACE_ENV]: a.workspaceId };
				expect(
					await applyCliSessionScope({
						commandPath: "task list",
						options: {},
						createClient: noServer as never,
						env,
					}),
				).toBeNull();
				expect((await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([a.workspaceId]);
				expect(await loadWorkspaceContextById(b.workspaceId)).toBeNull();
				await expect(loadWorkspaceContext(repoB)).rejects.toThrow("Project isolation");
				await expect(loadWorkspaceContext(repoNew)).rejects.toThrow("only the user registers projects");
				expect((await loadWorkspaceContext(repoA)).workspaceId).toBe(a.workspaceId);
			} finally {
				root.cleanup();
			}
		});
	});

	function addWorktree(repo: string, worktree: string): void {
		const env = createGitTestEnv();
		spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], { env });
		spawnSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "card", worktree], { env });
	}

	it("with isolation off nothing is scoped: the CLI behaves as before, from a task worktree too", async () => {
		await withTemporaryKanbanHome(async () => {
			const root = createTempDir("kanban-cli-scope-");
			try {
				const repoA = join(root.path, "a");
				const repoB = join(root.path, "b");
				const worktree = join(root.path, "worktrees", "t1", "a");
				for (const repo of [repoA, repoB]) {
					initRepo(repo);
				}
				addWorktree(repoA, worktree);
				const a = await loadWorkspaceContext(repoA);
				await loadWorkspaceContext(repoB);
				const createClient = vi.fn(noServer);
				const env = { ...SESSION_ENV, [KANBAN_SESSION_WORKSPACE_ENV]: a.workspaceId };
				expect(
					await applyCliSessionScope({
						commandPath: "task list",
						options: {},
						createClient: createClient as never,
						env,
					}),
				).toBeNull();
				expect(createClient).not.toHaveBeenCalled();
				expect(await listWorkspaceIndexEntries()).toHaveLength(2);
				expect((await loadWorkspaceContext(repoB)).repoPath).toContain("b");
				// `kanban task list` without --project-path in a task worktree: as before isolation, unscoped.
				const fromWorktree = await loadWorkspaceContext(worktree, { autoCreateIfMissing: false }).catch(
					(error: Error) => error.message,
				);
				const unguarded = await (async () => {
					setWorkspaceAccessGuard(null);
					return await loadWorkspaceContext(worktree, { autoCreateIfMissing: false }).catch(
						(error: Error) => error.message,
					);
				})();
				expect(fromWorktree).toEqual(unguarded);
			} finally {
				root.cleanup();
			}
		});
	});

	it("under isolation a task worktree resolves to its project", async () => {
		await withTemporaryKanbanHome(async () => {
			const root = createTempDir("kanban-cli-scope-");
			try {
				const repoA = join(root.path, "a");
				const worktree = join(root.path, "worktrees", "t1", "a");
				initRepo(repoA);
				addWorktree(repoA, worktree);
				const a = await loadWorkspaceContext(repoA);
				writeConfig({ isolation: { mode: "enforce" } });
				const env = { ...SESSION_ENV, [KANBAN_SESSION_WORKSPACE_ENV]: a.workspaceId };
				await applyCliSessionScope({ commandPath: "task list", options: {}, createClient: noServer as never, env });
				expect(await loadWorkspaceContext(worktree)).toMatchObject({
					workspaceId: a.workspaceId,
					repoPath: a.repoPath,
				});
			} finally {
				root.cleanup();
			}
		});
	});
});
