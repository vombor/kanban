// `kanban task create --project-path <unregistered repo>`: the CLI never writes the workspace index itself. A project
// that isn't registered goes through the running server's `projects.add` (here the real router, projects API and
// isolation service behind the mocked tRPC client), which refuses agent sessions in every isolation mode and paths
// outside the projects roots, for the user's shell too.
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createTask } from "../../src/commands/task";
import type { RuntimeCaller } from "../../src/isolation/session-identity";
import { listWorkspaceIndexEntries } from "../../src/state/workspace-state";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import { createCommittedRepo, createProjectsRouter } from "../utilities/projects-router";

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

/** The runtime server as the CLI reaches it, with `caller` as whoever runs the CLI. */
async function connectRuntime(input: { caller: RuntimeCaller; raw: Record<string, unknown>; root: string }) {
	const router = await createProjectsRouter(input);
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
				const repoPath = createCommittedRepo(root, "new-repo");
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
			const repoPath = createCommittedRepo(join(home, "outside"), "repo");
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
			const repoPath = createCommittedRepo(root, "repo");
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
