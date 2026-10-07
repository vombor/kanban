// Session sync next to the legacy kit's column-sync (both run until the cutover disables the kit's): they write
// the same board file, the runtime through mutateWorkspaceState and the kit through workspace.saveState with
// expectedRevision. Whoever moves second must find nothing left to do, and neither may undo the other's move.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { moveTaskToTopOfColumn } from "../../src/core/task-board-mutations";
import { createSessionColumnSync, planSessionColumnMoves } from "../../src/server/session-column-sync";
import { loadWorkspaceState, mutateWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import { createBoard, createCard, findCardInBoard } from "../utilities/workspace-state-store";

function createSummary(
	taskId: string,
	state: RuntimeTaskSessionSummary["state"],
	updatedAt: number,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "cline",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt,
		lastOutputAt: null,
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

/** The kit's tick: plan with the same rules, then save the whole board with the revision it read. */
function kitMovedBoard(board: RuntimeBoardData, summaries: RuntimeTaskSessionSummary[]): RuntimeBoardData | null {
	const moves = planSessionColumnMoves(board, summaries);
	if (moves.length === 0) {
		return null;
	}
	return moves.reduce((next, move) => moveTaskToTopOfColumn(next, move.taskId, move.to).board, board);
}

async function withWorkspace(run: (workspacePath: string) => Promise<void>): Promise<void> {
	await withTemporaryKanbanHome(async (home) => {
		const workspacePath = join(home.userHomePath, "project");
		mkdirSync(workspacePath, { recursive: true });
		const init = spawnSync("git", ["init"], { cwd: workspacePath, stdio: "ignore", env: createGitTestEnv() });
		expect(init.status).toBe(0);
		const initial = await loadWorkspaceState(workspacePath);
		await saveWorkspaceState(workspacePath, {
			board: createBoard({ in_progress: [createCard({ id: "task-1", updatedAt: 100 })] }),
			sessions: {},
			expectedRevision: initial.revision,
		});
		await run(workspacePath);
	});
}

function createSync(workspacePath: string, summaries: Map<string, RuntimeTaskSessionSummary>) {
	const listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	const sync = createSessionColumnSync({
		listWorkspaces: () => [{ workspaceId: "ws", workspacePath }],
		mutateWorkspaceState,
	});
	sync.trackWorkspace("ws", {
		onSummary: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		listSummaries: () => [...summaries.values()],
	});
	return sync;
}

describe.sequential("session column sync with the legacy kit's column-sync", () => {
	it("the runtime moves first: the kit's save conflicts and its next tick has nothing to move", async () => {
		await withWorkspace(async (workspacePath) => {
			const summaries = new Map([["task-1", createSummary("task-1", "awaiting_review", 500)]]);
			const kitRead = await loadWorkspaceState(workspacePath);
			const kitBoard = kitMovedBoard(kitRead.board, [...summaries.values()]);
			expect(kitBoard).not.toBeNull();

			const sync = createSync(workspacePath, summaries);
			try {
				await sync.syncWorkspace("ws");
			} finally {
				sync.close();
			}
			const afterRuntime = await loadWorkspaceState(workspacePath);
			expect(afterRuntime.revision).toBe(kitRead.revision + 1);
			expect(findCardInBoard(afterRuntime.board, "task-1")?.columnId).toBe("review");

			await expect(
				saveWorkspaceState(workspacePath, {
					board: kitBoard as RuntimeBoardData,
					sessions: kitRead.sessions,
					expectedRevision: kitRead.revision,
				}),
			).rejects.toMatchObject({ name: "WorkspaceStateConflictError" });
			// Next kit tick: same rules, same guard, card already in Review.
			const kitRetry = await loadWorkspaceState(workspacePath);
			expect(kitMovedBoard(kitRetry.board, [...summaries.values()])).toBeNull();
		});
	});

	it("the kit moves first: the runtime finds the card in place and writes nothing", async () => {
		await withWorkspace(async (workspacePath) => {
			const summaries = new Map([["task-1", createSummary("task-1", "awaiting_review", 500)]]);
			const kitRead = await loadWorkspaceState(workspacePath);
			const kitBoard = kitMovedBoard(kitRead.board, [...summaries.values()]);
			const kitSaved = await saveWorkspaceState(workspacePath, {
				board: kitBoard as RuntimeBoardData,
				sessions: kitRead.sessions,
				expectedRevision: kitRead.revision,
			});

			const sync = createSync(workspacePath, summaries);
			try {
				await sync.syncWorkspace("ws");
			} finally {
				sync.close();
			}
			const after = await loadWorkspaceState(workspacePath);
			expect(after.revision).toBe(kitSaved.revision);
			expect(findCardInBoard(after.board, "task-1")?.columnId).toBe("review");
		});
	});
});
