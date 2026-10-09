// `kanban task start` on a card whose live session already finished its turn (notes f423d, issue #16): the runtime
// refuses the start (`requireNewTurn`, decided by the session manager's own reuse rule; runtime-api.test.ts), and the
// card stays where it was instead of sitting in In Progress on a reattached session with no new turn.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTask, startTask } from "../../src/commands/task";
import { getTaskColumnId } from "../../src/core/task-board-mutations";
import { loadWorkspaceContext, loadWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";

const runtime = vi.hoisted(() => ({
	startTaskSession: vi.fn(
		async (): Promise<{ ok: boolean; summary: unknown; error?: string }> => ({
			ok: true,
			summary: { state: "running" },
		}),
	),
	repoPath: "",
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: { add: { mutate: async () => ({ ok: true }) } },
		workspace: {
			notifyStateUpdated: { mutate: async () => ({ ok: true }) },
			getState: { query: async () => await loadWorkspaceState(runtime.repoPath) },
			ensureWorktree: { mutate: async () => ({ ok: true }) },
		},
		runtime: { startTaskSession: { mutate: runtime.startTaskSession } },
	}),
	httpBatchLink: () => null,
}));

function createRepo(userHomePath: string): string {
	const repoPath = join(userHomePath, "notes");
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

describe("kanban task start", () => {
	it("asks for a new turn, and leaves the card in Backlog when the runtime would only reattach a finished session", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repoPath = createRepo(userHomePath);
			runtime.repoPath = repoPath;
			await loadWorkspaceContext(repoPath);
			const created = await createTask({ cwd: repoPath, projectPath: repoPath, prompt: "Build it", agentId: null });
			const taskId = (created.task as { id: string }).id;
			runtime.startTaskSession.mockResolvedValueOnce({
				ok: false,
				summary: { state: "awaiting_review" },
				error: `Task "${taskId}" has a live session that finished its turn (awaiting review)`,
			});

			await expect(startTask({ cwd: repoPath, projectPath: repoPath, taskId })).rejects.toThrow(
				"finished its turn (awaiting review)",
			);
			expect(runtime.startTaskSession).toHaveBeenCalledWith(
				expect.objectContaining({ taskId, requireNewTurn: true }),
			);
			expect(getTaskColumnId((await loadWorkspaceState(repoPath)).board, taskId)).toBe("backlog");

			// A start the runtime takes (a new process) moves it to In Progress as before.
			await startTask({ cwd: repoPath, projectPath: repoPath, taskId });
			expect(getTaskColumnId((await loadWorkspaceState(repoPath)).board, taskId)).toBe("in_progress");
		});
	});
});
