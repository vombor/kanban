// Bare `kanban` and server startup in a directory: a new project is registered only through the rules of
// `projects.add` (src/projects/launch-project.ts). In-process only for a starting server that owns the port, and
// then only inside a projects root, never for an agent session or a task worktree; with a server running, only
// through its `projects.add` (the real router here), whose isolation rule refuses a session without the env credential.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../../src/config/runtime-config";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import {
	registerLaunchProjectInProcess,
	registerLaunchProjectThroughServer,
	resolveLaunchProject,
} from "../../../src/projects/launch-project";
import { resolveProjectRoots } from "../../../src/projects/project-roots";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import { getTaskWorktreesRootPath } from "../../../src/state/kanban-home";
import { listWorkspaceIndexEntries, loadWorkspaceContext } from "../../../src/state/workspace-state";
import { describeBrokenGitRepository, hasGitRepository } from "../../../src/workspace/repo-health";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createCommittedRepo, createProjectsRouter } from "../../utilities/projects-router";

const SESSION: RuntimeCaller = {
	kind: "session",
	session: { workspaceId: "other", taskId: "t1", role: "card", agentId: "codex", cwd: "/w/t1" },
	via: "credential",
};
const USER: RuntimeCaller = { kind: "user" };
const AGENT_ENV = { KANBAN_SESSION_CREDENTIAL: "c".repeat(48) };

async function registeredPaths(): Promise<string[]> {
	return (await listWorkspaceIndexEntries()).map((entry) => entry.repoPath);
}

/** A repo under `<home>/projects` (the only root) or elsewhere, and the launch inputs for it. */
function setup(userHomePath: string, where: "root" | "outside" = "root") {
	const home = realpathSync(userHomePath);
	const root = join(home, "projects");
	mkdirSync(root, { recursive: true });
	const repoPath = createCommittedRepo(where === "root" ? root : join(home, "outside"), "repo");
	return {
		root,
		repoPath,
		launch: {
			hasGitRepository,
			readProjectRoots: async () => await resolveProjectRoots([root]),
			log: vi.fn(),
			warn: vi.fn(),
		},
	};
}

async function startUp(cwd: string, launch: ReturnType<typeof setup>["launch"], env: NodeJS.ProcessEnv = {}) {
	const registry = await createWorkspaceRegistry({
		cwd,
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository,
		describeBrokenGitRepository,
		pathIsDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
		logError: () => {},
	});
	// Before the bind: nothing registered, whatever the cwd.
	expect(await registeredPaths()).toEqual([]);
	const opened = await registerLaunchProjectInProcess({
		...launch,
		cwd,
		env,
		setActiveWorkspace: registry.setActiveWorkspace,
	});
	return { registry, opened };
}

async function throughServer(input: {
	cwd: string;
	launch: ReturnType<typeof setup>["launch"];
	caller: RuntimeCaller;
	root: string;
	env?: NodeJS.ProcessEnv;
}) {
	const router = await createProjectsRouter({ caller: input.caller, raw: {}, root: input.root });
	const add = vi.fn(async (body: { path: string }) => await router.projects.add(body));
	const workspaceId = await registerLaunchProjectThroughServer({
		...input.launch,
		cwd: input.cwd,
		env: input.env ?? {},
		client: { projects: { add: { mutate: add } } } as never,
	});
	return { workspaceId, add, router };
}

describe("server startup in an unregistered directory", () => {
	it("registers a repo under a projects root from the user's shell, once bound, and makes it active", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { repoPath, launch } = setup(userHomePath);
			const { registry, opened } = await startUp(repoPath, launch);
			expect(await registeredPaths()).toEqual([repoPath]);
			expect(registry.getActiveWorkspacePath()).toBe(repoPath);
			expect(opened?.repoPath).toBe(repoPath);
			expect(launch.log).toHaveBeenCalledWith(`Added project ${repoPath}.`);
		});
	});

	it("refuses a repo outside the projects roots with the reason", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { repoPath, launch } = setup(userHomePath, "outside");
			const { registry } = await startUp(repoPath, launch);
			expect(await registeredPaths()).toEqual([]);
			expect(registry.getActiveWorkspacePath()).toBeNull();
			expect(launch.warn).toHaveBeenCalledWith(expect.stringContaining(`Not adding ${repoPath}`));
			expect(launch.warn).toHaveBeenCalledWith(expect.stringContaining("outside the projects root"));
		});
	});

	it("registers nothing for an agent session (a session credential in the env)", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { repoPath, launch } = setup(userHomePath);
			await startUp(repoPath, launch, AGENT_ENV);
			expect(await registeredPaths()).toEqual([]);
			expect(launch.warn).toHaveBeenCalledWith(expect.stringContaining("agent session"));
		});
	});

	it("opens a registered project outside the roots as before", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { repoPath, launch } = setup(userHomePath, "outside");
			const { workspaceId } = await loadWorkspaceContext(repoPath);
			const registry = await createWorkspaceRegistry({
				cwd: repoPath,
				loadGlobalRuntimeConfig,
				loadRuntimeConfig,
				hasGitRepository,
				describeBrokenGitRepository,
				pathIsDirectory: async () => true,
				logError: () => {},
			});
			expect(registry.getActiveWorkspaceId()).toBe(workspaceId);
			expect(await resolveLaunchProject({ ...launch, cwd: repoPath })).toMatchObject({
				kind: "registered",
				repoPath,
			});
			expect(await registeredPaths()).toEqual([repoPath]);
		});
	});
});

describe("bare kanban with a server running", () => {
	it("registers a repo under a root from the user's shell through projects.add", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { root, repoPath, launch } = setup(userHomePath);
			const { workspaceId, add } = await throughServer({ cwd: repoPath, launch, caller: USER, root });
			expect(add).toHaveBeenCalledWith({ path: repoPath });
			expect(await listWorkspaceIndexEntries()).toEqual([expect.objectContaining({ workspaceId, repoPath })]);
		});
	});

	it("refuses a repo outside the roots without asking the server", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { root, repoPath, launch } = setup(userHomePath, "outside");
			const { workspaceId, add } = await throughServer({ cwd: repoPath, launch, caller: USER, root });
			expect(workspaceId).toBeNull();
			expect(add).not.toHaveBeenCalled();
			expect(await registeredPaths()).toEqual([]);
			expect(launch.warn).toHaveBeenCalledWith(expect.stringContaining("outside the projects root"));
		});
	});

	it("an agent session registers nothing: with a credential nothing is sent, without one the server refuses", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { root, repoPath, launch } = setup(userHomePath);
			const withCredential = await throughServer({ cwd: repoPath, launch, caller: SESSION, root, env: AGENT_ENV });
			expect(withCredential.add).not.toHaveBeenCalled();
			// A session that dropped its env: the server traces it to the session and refuses.
			const traced = await throughServer({ cwd: repoPath, launch, caller: SESSION, root });
			expect(traced.add).toHaveBeenCalledTimes(1);
			expect(traced.workspaceId).toBeNull();
			expect(launch.warn).toHaveBeenLastCalledWith(expect.stringContaining("Only the user can register"));
			expect(await registeredPaths()).toEqual([]);
		});
	});

	it("opens a registered project without projects.add", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { root, repoPath, launch } = setup(userHomePath);
			const { workspaceId } = await loadWorkspaceContext(repoPath);
			const opened = await throughServer({ cwd: repoPath, launch, caller: SESSION, root, env: AGENT_ENV });
			expect(opened.workspaceId).toBe(workspaceId);
			expect(opened.add).not.toHaveBeenCalled();
		});
	});
});

describe("a Kanban task worktree is never a project", () => {
	it("is refused at startup, by bare kanban and by projects.add, even inside a projects root", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const home = realpathSync(userHomePath);
			// The whole user home is the root, so only the worktree rule refuses it.
			const mainRepo = createCommittedRepo(join(home, "projects"), "main");
			const worktreesRoot = getTaskWorktreesRootPath();
			mkdirSync(join(worktreesRoot, "abc12"), { recursive: true });
			const worktreePath = join(worktreesRoot, "abc12", "main");
			execFileSync("git", ["worktree", "add", "-q", "--detach", worktreePath], {
				cwd: mainRepo,
				env: createGitTestEnv(),
			});
			const launch = {
				hasGitRepository,
				readProjectRoots: async () => await resolveProjectRoots([home]),
				log: vi.fn(),
				warn: vi.fn(),
			};

			await startUp(worktreePath, launch);
			expect(launch.warn).toHaveBeenLastCalledWith(expect.stringContaining("is a Kanban task worktree"));

			const viaServer = await throughServer({ cwd: worktreePath, launch, caller: USER, root: home });
			expect(viaServer.add).not.toHaveBeenCalled();
			// projects.add itself (Open folder, `kanban task --project-path`) refuses it too.
			const added = await viaServer.router.projects.add({ path: worktreePath });
			expect(added).toMatchObject({ ok: false, error: expect.stringContaining("is a Kanban task worktree") });
			expect(await registeredPaths()).toEqual([]);
		});
	});
});
