// Issue #6: `kanban task create|start` on an already registered project must never reach the runtime's project-add
// check (`projects.add`, refused to every agent session and, from a detached process, refused as "register a Kanban
// project"). Unregistered projects: task-command-registration.test.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTask, startTask } from "../../src/commands/task";
import { loadWorkspaceContext, loadWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";

const runtime = vi.hoisted(() => ({
	addProject: vi.fn(async (input: { path: string }) => ({ ok: true, project: { id: `added:${input.path}` } })),
	startTaskSession: vi.fn(async () => ({ ok: true, summary: { state: "running" } })),
	repoPath: "",
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: { add: { mutate: runtime.addProject } },
		workspace: {
			notifyStateUpdated: { mutate: async () => ({ ok: true }) },
			getState: { query: async () => await loadWorkspaceState(runtime.repoPath) },
			ensureWorktree: { mutate: async () => ({ ok: true }) },
		},
		runtime: { startTaskSession: { mutate: runtime.startTaskSession } },
	}),
	httpBatchLink: () => null,
}));

function createRepo(userHomePath: string, name: string): string {
	const repoPath = join(userHomePath, name);
	mkdirSync(repoPath);
	const env = createGitTestEnv();
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath, env });
	writeFileSync(join(repoPath, "a.txt"), "a\n");
	execFileSync("git", ["add", "."], { cwd: repoPath, env });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], { cwd: repoPath, env });
	return repoPath;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("task commands on a registered project", () => {
	it("create and start never call projects.add for a registered project", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repoPath = createRepo(userHomePath, "registered");
			runtime.repoPath = repoPath;
			const { workspaceId } = await loadWorkspaceContext(repoPath);
			const created = await createTask({ cwd: repoPath, projectPath: repoPath, prompt: "Build it", agentId: null });
			expect(created).toMatchObject({ ok: true });
			expect(workspaceId).toBeTruthy();
			const taskId = (created.task as { id: string }).id;
			await startTask({ cwd: repoPath, projectPath: repoPath, taskId });
			expect(runtime.startTaskSession).toHaveBeenCalledTimes(1);
			expect(runtime.addProject).not.toHaveBeenCalled();
		});
	});
});
