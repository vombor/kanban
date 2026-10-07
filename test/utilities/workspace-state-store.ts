import { vi } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core/api-contract";
import type { CreateTaskTrashWorkflowDependencies } from "../../src/server/task-trash-workflow";

export interface StoredWorkspaceState {
	board: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	revision: number;
}

export function createCard(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	return {
		title: `Task ${overrides.id}`,
		prompt: `Do work for ${overrides.id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

export function createBoard(
	cardsByColumn: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>,
	dependencies: RuntimeBoardData["dependencies"] = [],
): RuntimeBoardData {
	const columnIds: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return {
		columns: columnIds.map((columnId) => ({
			id: columnId,
			title: columnId,
			cards: cardsByColumn[columnId] ?? [],
		})),
		dependencies,
	};
}

export function findCardInBoard(
	board: RuntimeBoardData,
	taskId: string,
): { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, columnId: column.id };
		}
	}
	return null;
}

/**
 * In-memory stand-in for the workspace state files. `getWorkspaceState` and
 * `mutateWorkspaceState` mirror the read-modify-write semantics of
 * src/state/workspace-state.ts, including the revision bump on save and the
 * ability to refuse a save (`save: false`).
 */
export function createWorkspaceStateStore(initial: StoredWorkspaceState) {
	const stored = initial;

	const toResponse = (): RuntimeWorkspaceStateResponse =>
		({
			repoPath: "/repo",
			statePath: "/repo/.cline",
			git: { root: "/repo", currentBranch: "main", defaultBranch: "main" },
			board: structuredClone(stored.board),
			sessions: structuredClone(stored.sessions),
			revision: stored.revision,
		}) as unknown as RuntimeWorkspaceStateResponse;

	return {
		stored,
		getWorkspaceState: async (): Promise<RuntimeWorkspaceStateResponse> => toResponse(),
		mutateWorkspaceState: async <T>(
			_cwd: string,
			mutate: (state: RuntimeWorkspaceStateResponse) => {
				board: RuntimeBoardData;
				sessions?: Record<string, RuntimeTaskSessionSummary>;
				value: T;
				save?: boolean;
			},
		): Promise<{ value: T; state: RuntimeWorkspaceStateResponse; saved: boolean }> => {
			const current = toResponse();
			const result = mutate(current);
			if (result.save === false) {
				return { value: result.value, state: current, saved: false };
			}
			stored.board = result.board;
			if (result.sessions) {
				stored.sessions = result.sessions;
			}
			stored.revision += 1;
			return { value: result.value, state: toResponse(), saved: true };
		},
	};
}

export type WorkspaceStateStore = ReturnType<typeof createWorkspaceStateStore>;

/**
 * Done-workflow dependencies backed by the in-memory store, with the side
 * effects (sessions, worktrees) recorded as mocks.
 */
export function createFakeTaskTrashWorkflowDependencies(store: WorkspaceStateStore) {
	const stopTaskSession = vi.fn(async (_scope: unknown, _taskId: string) => {});
	const deleteTaskWorktree = vi.fn(async (_scope: unknown, _taskId: string) => ({ ok: true, removed: true }));
	const ensureTaskWorktree = vi.fn(
		async (_scope: unknown, input: { taskId: string; baseRef: string }): Promise<RuntimeWorktreeEnsureResponse> => ({
			ok: true,
			path: `/worktrees/${input.taskId}`,
			baseRef: input.baseRef,
			baseCommit: "base-commit",
		}),
	);
	const startTaskSession = vi.fn(async (_scope: unknown, input: { taskId: string }) => ({
		ok: true,
		summary: { taskId: input.taskId, state: "running" } as unknown as RuntimeTaskSessionSummary,
	}));
	const onBoardMutated = vi.fn();
	const dependencies = {
		mutateWorkspaceState: store.mutateWorkspaceState,
		stopTaskSession,
		deleteTaskWorktree,
		ensureTaskWorktree,
		startTaskSession,
		onBoardMutated,
	} satisfies CreateTaskTrashWorkflowDependencies;
	return { dependencies, stopTaskSession, deleteTaskWorktree, ensureTaskWorktree, startTaskSession, onBoardMutated };
}
