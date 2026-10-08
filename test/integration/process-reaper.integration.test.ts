import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProcessReaper } from "../../src/server/process-reaper";
import { createProcProcessTableReader, isProcessTableSupported } from "../../src/server/process-table";
import { createTaskTrashWorkflow } from "../../src/server/task-trash-workflow";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorktreeCandidatePaths,
} from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import { createTempDir, realPath } from "../utilities/temp-dir";
import {
	createBoard,
	createCard,
	createFakeTaskTrashWorkflowDependencies,
	createWorkspaceStateStore,
	findCardInBoard,
} from "../utilities/workspace-state-store";

const hasSetsid = isProcessTableSupported() && spawnSync("setsid", ["--version"]).status === 0;

function runGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 5_000): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== null) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}

describe.skipIf(!hasSetsid).sequential("process reaper integration", () => {
	it("the Done workflow reaps a detached (setsid) process running in the card's worktree", async () => {
		await withTemporaryKanbanHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-process-reaper-");
			const reader = createProcProcessTableReader();
			const children: ChildProcess[] = [];
			let orphanPid: number | null = null;
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });
				runGit(repoPath, ["init", "-q"]);
				writeFileSync(join(repoPath, "README.md"), "hello\n");
				runGit(repoPath, ["add", "README.md"]);
				runGit(repoPath, ["commit", "-q", "-m", "init"]);
				const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: "task-1", baseRef: "HEAD" });
				if (!ensured.ok || !ensured.path) {
					throw new Error(ensured.error ?? "Task worktree was not created");
				}
				const worktreePath = ensured.path;

				// Detached like an agent's `setsid npm run dev &`: the spawned process is a session leader, so
				// setsid forks and exits, and `sleep` is reparented away from the test (no parent chain, no group).
				const detached = spawn("setsid", ["sleep", "3601"], { cwd: worktreePath, detached: true, stdio: "ignore" });
				detached.unref();
				children.push(detached);
				// Outside the worktree: must survive.
				const bystander = spawn("sleep", ["3602"], { cwd: sandboxRoot, stdio: "ignore" });
				children.push(bystander);

				orphanPid = await waitFor(async () => {
					const entries = await reader.list();
					return (
						entries.find((entry) => entry.cwd === realPath(worktreePath) && entry.command === "sleep 3601")
							?.pid ?? null
					);
				});
				expect(orphanPid).not.toBeNull();

				const store = createWorkspaceStateStore({
					board: createBoard({ review: [createCard({ id: "task-1", baseRef: "HEAD" })] }),
					sessions: {},
					revision: 1,
				});
				const reaper = createProcessReaper({ reader });
				const workflow = createTaskTrashWorkflow({
					...createFakeTaskTrashWorkflowDependencies(store).dependencies,
					deleteTaskWorktree: async (scope, taskId) =>
						await deleteTaskWorktree({ repoPath: scope.workspacePath, taskId }),
					prepareProcessReap: async (scope, taskId) =>
						await reaper.prepareWorktreeReap({
							taskId,
							worktreePaths: getTaskWorktreeCandidatePaths(scope.workspacePath, taskId),
							sessionPids: [],
						}),
				});

				const result = await workflow.trashTask({
					workspaceId: "ws-1",
					workspacePath: repoPath,
					taskId: "task-1",
					trigger: "cli",
				});

				expect(result).toMatchObject({ ok: true, status: "trashed", worktreeDeleted: true });
				expect(findCardInBoard(store.stored.board, "task-1")?.columnId).toBe("trash");
				expect(existsSync(worktreePath)).toBe(false);
				const pid = orphanPid as number;
				const gone = await waitFor(async () => {
					const entry = await reader.read(pid);
					return entry === null || entry.state === "Z" || entry.command !== "sleep 3601" ? true : null;
				});
				expect(gone).toBe(true);
				expect(bystander.exitCode).toBeNull();
				expect(bystander.signalCode).toBeNull();
			} finally {
				// Only the test's own children.
				for (const child of children) {
					if (child.exitCode === null && child.signalCode === null && child.pid) {
						child.kill("SIGKILL");
					}
				}
				const leftover = orphanPid === null ? null : await reader.read(orphanPid);
				if (leftover && leftover.command === "sleep 3601") {
					process.kill(leftover.pid, "SIGKILL");
				}
				cleanup();
			}
		});
	});
});
