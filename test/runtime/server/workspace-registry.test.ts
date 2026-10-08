import { existsSync, mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../../src/config/runtime-config";
import {
	applyLiveSessionStateToProjectTaskCounts,
	createWorkspaceRegistry,
} from "../../../src/server/workspace-registry";
import {
	getWorkspaceDirectoryPath,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
} from "../../../src/state/workspace-state";
import { describeBrokenGitRepository, hasGitRepository } from "../../../src/workspace/repo-health";
import { createRepoWithWorktree, git } from "../../utilities/git-repo";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function createRegistry(cwd: string, logError: (message: string) => void = () => {}) {
	return await createWorkspaceRegistry({
		cwd,
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository,
		describeBrokenGitRepository,
		pathIsDirectory,
		logError,
	});
}

describe("workspace registry: project task counts", () => {
	it("counts an interrupted card as Done only with session sync off (a restart's orphans stay where they are)", () => {
		const board = createBoard({
			in_progress: [createCard({ id: "orphan" })],
			review: [createCard({ id: "finished" })],
		});
		const counts = { backlog: 0, in_progress: 1, review: 1, trash: 0 };
		const sessions = {
			orphan: { taskId: "orphan", state: "interrupted" },
			finished: { taskId: "finished", state: "awaiting_review" },
		} as unknown as Parameters<typeof applyLiveSessionStateToProjectTaskCounts>[2];
		expect(applyLiveSessionStateToProjectTaskCounts(counts, board, sessions, { sessionSyncEnabled: true })).toEqual(
			counts,
		);
		expect(applyLiveSessionStateToProjectTaskCounts(counts, board, sessions, { sessionSyncEnabled: false })).toEqual({
			...counts,
			in_progress: 0,
			trash: 1,
		});
	});
});

describe("workspace registry: stream resolution", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("keeps the board of a project whose git config says core.bare=true and opens it again once repaired", async () => {
		await withTemporaryKanbanHome(async () => {
			const repo = createRepoWithWorktree();
			cleanups.push(repo.cleanup);
			const outside = createTempDir();
			cleanups.push(outside.cleanup);
			const { workspaceId } = await loadWorkspaceContext(repo.repoPath);
			mkdirSync(getWorkspaceDirectoryPath(workspaceId), { recursive: true });
			const errors = vi.fn();
			const registry = await createRegistry(outside.path, errors);
			git(repo.repoPath, ["config", "core.bare", "true"]);

			const onRemovedWorkspace = vi.fn();
			const first = await registry.resolveWorkspaceForStream(workspaceId, { onRemovedWorkspace });
			const second = await registry.resolveWorkspaceForStream(workspaceId, { onRemovedWorkspace });

			expect(onRemovedWorkspace).not.toHaveBeenCalled();
			expect(first).toMatchObject({ workspaceId: null, didPruneProjects: false });
			expect(first.unhealthyRequestedWorkspaceMessage).toContain("core.bare=true");
			expect(second.unhealthyRequestedWorkspaceMessage).toBe(first.unhealthyRequestedWorkspaceMessage);
			expect((await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([workspaceId]);
			expect(existsSync(getWorkspaceDirectoryPath(workspaceId))).toBe(true);
			expect(errors).toHaveBeenCalledTimes(1);
			expect(String(errors.mock.calls[0]?.[0])).toContain(`UNHEALTHY PROJECT ${workspaceId}`);

			git(repo.repoPath, ["config", "core.bare", "false"]);
			const repaired = await registry.resolveWorkspaceForStream(workspaceId);
			expect(repaired).toMatchObject({ workspaceId, unhealthyRequestedWorkspaceMessage: null });
		});
	});

	it("still removes a project whose directory is no git repository at all", async () => {
		await withTemporaryKanbanHome(async () => {
			const repo = createRepoWithWorktree();
			cleanups.push(repo.cleanup);
			const outside = createTempDir();
			cleanups.push(outside.cleanup);
			const { workspaceId } = await loadWorkspaceContext(repo.repoPath);
			mkdirSync(getWorkspaceDirectoryPath(workspaceId), { recursive: true });
			const registry = await createRegistry(outside.path);
			rmSync(repo.worktreePath, { recursive: true, force: true });
			rmSync(join(repo.repoPath, ".git"), { recursive: true, force: true });

			const onRemovedWorkspace = vi.fn();
			const resolved = await registry.resolveWorkspaceForStream(workspaceId, { onRemovedWorkspace });

			expect(resolved).toMatchObject({ workspaceId: null, didPruneProjects: true });
			expect(onRemovedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
			expect(await listWorkspaceIndexEntries()).toEqual([]);
			expect(existsSync(getWorkspaceDirectoryPath(workspaceId))).toBe(false);
		});
	});
});
