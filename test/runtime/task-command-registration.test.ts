// `kanban task create --project-path <unregistered repo>`: the CLI never writes the workspace index itself. A project
// that isn't registered goes through the running server's `projects.add` (here the real router, projects API and
// isolation service behind the mocked tRPC client), which refuses agent sessions in every isolation mode and paths
// outside the projects roots, for the user's shell too.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createTask } from "../../src/commands/task";
import { parsePipelineConfig } from "../../src/config/pipeline-config";
import { createIsolationService } from "../../src/isolation/isolation-service";
import type { RuntimeCaller } from "../../src/isolation/session-identity";
import { resolveProjectRoots } from "../../src/projects/project-roots";
import { listWorkspaceIndexEntries } from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolationApi } from "../../src/trpc/isolation-api";
import { createProjectsApi } from "../../src/trpc/projects-api";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";

const harness = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => harness.client,
	httpBatchLink: () => null,
}));

const SESSION: RuntimeCaller = {
	kind: "session",
	session: { workspaceId: "other", taskId: "t1", role: "card", agentId: "codex", cwd: "/w/t1" },
	via: "credential",
};

function createRepo(parent: string, name: string): string {
	const repoPath = join(parent, name);
	mkdirSync(repoPath, { recursive: true });
	const env = createGitTestEnv();
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath, env });
	writeFileSync(join(repoPath, "a.txt"), "a\n");
	execFileSync("git", ["add", "."], { cwd: repoPath, env });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], { cwd: repoPath, env });
	return repoPath;
}

/** The runtime server as the CLI reaches it, with `caller` as whoever runs the CLI. */
async function connectRuntime(input: { caller: RuntimeCaller; raw: Record<string, unknown>; root: string }) {
	const service = createIsolationService({
		readConfig: async () => parsePipelineConfig(input.raw).config,
		processReader: null,
		listLiveSessions: () => [],
		log: async () => {},
		announceApproval: () => {},
	});
	const projectRoots = await resolveProjectRoots([input.root]);
	const projectsApi = createProjectsApi({
		getActiveWorkspacePath: () => null,
		getActiveWorkspaceId: () => null,
		rememberWorkspace: () => {},
		setActiveWorkspace: async () => {},
		clearActiveWorkspace: () => {},
		resolveProjectInputPath: (inputPath: string, cwd: string) => resolve(cwd, inputPath),
		assertPathIsDirectory: async () => {},
		hasGitRepository: (path: string) => existsSync(join(path, ".git")),
		summarizeProjectTaskCounts: async () => ({ backlog: 0, in_progress: 0, review: 0, trash: 0 }),
		createProjectSummary: ({ workspaceId, repoPath }) => ({
			id: workspaceId,
			path: repoPath,
			name: workspaceId,
			taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		}),
		broadcastRuntimeProjectsUpdated: async () => {},
		getTerminalManagerForWorkspace: () => null,
		disposeWorkspace: () => ({ terminalManager: null, workspacePath: null }),
		collectProjectWorktreeTaskIdsForRemoval: () => new Set<string>(),
		warn: () => {},
		buildProjectsPayload: async () => ({ currentProjectId: null, projects: [] }),
		pickDirectoryPathFromSystemDialog: () => null,
		serverCwd: input.root,
		readProjectRoots: async () => projectRoots,
	} as Parameters<typeof createProjectsApi>[0]);
	const router = runtimeAppRouter.createCaller({
		requestedWorkspaceId: null,
		workspaceScope: null,
		getCaller: async () => input.caller,
		resolveStrictCaller: async () => input.caller,
		trustedBrowser: false,
		isolationApi: createIsolationApi({
			service,
			listEntries: listWorkspaceIndexEntries,
			notices: { allowSend: () => true, enqueue: () => {} },
		}),
		projectsApi,
	} as unknown as RuntimeTrpcContext);
	const addProject = vi.fn(async (body: { path: string }) => await router.projects.add(body));
	harness.client = {
		projects: { add: { mutate: addProject } },
		workspace: { notifyStateUpdated: { mutate: async () => ({ ok: true }) } },
	};
	return { addProject };
}

async function registeredPaths(): Promise<string[]> {
	return (await listWorkspaceIndexEntries()).map((entry) => entry.repoPath);
}

describe("task create on an unregistered --project-path", () => {
	for (const mode of ["off", "report", "enforce"] as const) {
		it(`an agent session registers nothing (isolation ${mode})`, async () => {
			await withTemporaryKanbanHome(async ({ userHomePath }) => {
				const root = join(realpathSync(userHomePath), "projects");
				const repoPath = createRepo(root, "new-repo");
				const { addProject } = await connectRuntime({ caller: SESSION, raw: { isolation: { mode } }, root });
				await expect(
					createTask({ cwd: repoPath, projectPath: repoPath, prompt: "Build it", agentId: null }),
				).rejects.toThrow(`Only the user can register ${repoPath} as a Kanban project`);
				expect(addProject).toHaveBeenCalledTimes(1);
				expect(await registeredPaths()).toEqual([]);
			});
		});
	}

	it("a path outside the projects roots is refused, from the user's shell as well", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const home = realpathSync(userHomePath);
			mkdirSync(join(home, "projects"));
			const repoPath = createRepo(join(home, "outside"), "repo");
			await connectRuntime({ caller: { kind: "user" }, raw: {}, root: join(home, "projects") });
			await expect(
				createTask({ cwd: repoPath, projectPath: repoPath, prompt: "Build it", agentId: null }),
			).rejects.toThrow("outside the projects root");
			expect(await registeredPaths()).toEqual([]);
		});
	});

	it("the user's shell under a root still registers it, through the server", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const root = join(realpathSync(userHomePath), "projects");
			const repoPath = createRepo(root, "repo");
			const { addProject } = await connectRuntime({ caller: { kind: "user" }, raw: {}, root });
			const created = await createTask({ cwd: repoPath, projectPath: repoPath, prompt: "Build it", agentId: null });
			expect(created).toMatchObject({ ok: true });
			expect(addProject).toHaveBeenCalledWith({ path: repoPath });
			expect(await registeredPaths()).toEqual([repoPath]);
			// Registered now: the next command never reaches projects.add.
			await createTask({ cwd: repoPath, projectPath: repoPath, prompt: "Again", agentId: null });
			expect(addProject).toHaveBeenCalledTimes(1);
		});
	});
});
