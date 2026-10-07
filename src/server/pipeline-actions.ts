// The server side of the pipeline worker's action requests (src/pipeline/actions.ts). Each one runs through the
// code the CLI and the browser use, so a pipeline-made card is an ordinary card: board mutations under the
// workspace lock and the normal worktree + session start. `resumeTask` restarts a card restart recovery found orphaned. (Finishing a card is the worker's `finishTask` request,
// the Done workflow; typing into one is the watchdog's `deliverInput`.)
import { randomUUID } from "node:crypto";

import type {
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import { addTaskToColumn, getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import type { PipelineActionRequest, PipelineActionResult } from "../pipeline/actions";
import type { MutateWorkspaceState, TaskTrashWorkspaceScope } from "./task-trash-workflow";

export interface PipelineActionRunnerDependencies {
	mutateWorkspaceState: MutateWorkspaceState;
	ensureTaskWorktree: (
		scope: TaskTrashWorkspaceScope,
		input: { taskId: string; baseRef: string },
	) => Promise<RuntimeWorktreeEnsureResponse>;
	startTaskSession: (
		scope: TaskTrashWorkspaceScope,
		input: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
	/** Whether the task's session has a process; `resumeTask` never starts a second session over a live one. */
	hasLiveProcess?: (scope: TaskTrashWorkspaceScope, taskId: string) => Promise<boolean> | boolean;
	onBoardMutated?: (scope: TaskTrashWorkspaceScope) => Promise<void> | void;
	randomUuid?: () => string;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createPipelineActionRunner(
	deps: PipelineActionRunnerDependencies,
): (request: PipelineActionRequest) => Promise<PipelineActionResult> {
	const randomUuid = deps.randomUuid ?? randomUUID;
	const broadcast = async (scope: TaskTrashWorkspaceScope): Promise<void> => {
		await deps.onBoardMutated?.(scope);
	};

	const createTask = async (
		request: Extract<PipelineActionRequest, { kind: "createTask" }>,
	): Promise<PipelineActionResult> => {
		const { task } = request;
		await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const created = addTaskToColumn(
				state.board,
				"backlog",
				{
					taskId: task.taskId,
					title: task.title,
					prompt: task.prompt,
					role: task.role,
					reviewsTaskId: task.reviewsTaskId,
					agentId: task.agentId,
					agentSettings: task.agentSettings,
					baseRef: task.baseRef,
					autoReviewEnabled: false,
				},
				randomUuid,
			);
			return { board: created.board, value: created.task.id };
		});
		await broadcast(request);
		return { ok: true, detail: task.taskId };
	};

	const startTask = async (
		request: Extract<PipelineActionRequest, { kind: "startTask" }>,
	): Promise<PipelineActionResult> => {
		const { value: card } = await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const columnId = getTaskColumnId(state.board, request.taskId);
			const found =
				columnId === "backlog"
					? (state.board.columns
							.find((column) => column.id === "backlog")
							?.cards.find((candidate) => candidate.id === request.taskId) ?? null)
					: null;
			return { board: state.board, value: found, save: false };
		});
		if (!card) {
			return { ok: false, error: `task ${request.taskId} is not in Backlog` };
		}
		const ensured = await deps.ensureTaskWorktree(request, { taskId: card.id, baseRef: card.baseRef });
		if (!ensured.ok) {
			return { ok: false, error: ensured.error ?? "could not set up the task worktree" };
		}
		const started = await deps.startTaskSession(request, {
			taskId: card.id,
			prompt: card.prompt.trim(),
			taskTitle: card.title,
			images: card.images,
			startInPlanMode: card.startInPlanMode,
			baseRef: card.baseRef,
			agentId: card.agentId,
			agentSettings: card.agentSettings,
		});
		if (!started.ok || !started.summary) {
			return { ok: false, error: started.error ?? "could not start the task session" };
		}
		await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const moved = moveTaskToColumn(state.board, card.id, "in_progress");
			return { board: moved.board, value: null, save: moved.moved };
		});
		await broadcast(request);
		return { ok: true };
	};

	// Restart recovery: the card keeps its column until the session is up, then goes to In Progress (as resume-card did).
	const resumeTask = async (
		request: Extract<PipelineActionRequest, { kind: "resumeTask" }>,
	): Promise<PipelineActionResult> => {
		const { value: card } = await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const columnId = getTaskColumnId(state.board, request.taskId);
			const found =
				columnId === "in_progress" || columnId === "review"
					? (state.board.columns
							.find((column) => column.id === columnId)
							?.cards.find((candidate) => candidate.id === request.taskId) ?? null)
					: null;
			return { board: state.board, value: found, save: false };
		});
		if (!card) {
			return { ok: false, error: `task ${request.taskId} is not In Progress or in Review` };
		}
		// Restarted by hand since recovery planned it: startTaskSession would stop that live (if interrupted or
		// failed) session and start another.
		if (await deps.hasLiveProcess?.(request, card.id)) {
			return { ok: false, error: `task ${request.taskId} has a live session; not resumed` };
		}
		const ensured = await deps.ensureTaskWorktree(request, { taskId: card.id, baseRef: card.baseRef });
		if (!ensured.ok) {
			return { ok: false, error: ensured.error ?? "could not set up the task worktree" };
		}
		const started = await deps.startTaskSession(request, {
			taskId: card.id,
			prompt: request.prompt,
			taskTitle: card.title,
			startInPlanMode: false,
			baseRef: card.baseRef,
			agentId: request.agentId,
			agentSettings: card.agentSettings,
		});
		if (!started.ok || !started.summary) {
			return { ok: false, error: started.error ?? "could not start the task session" };
		}
		const { value: moved } = await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const movement = moveTaskToColumn(state.board, card.id, "in_progress");
			return { board: movement.board, value: movement.moved, save: movement.moved };
		});
		if (moved) {
			await broadcast(request);
		}
		return { ok: true, detail: moved ? "started, moved to In Progress" : "started" };
	};

	return async (request) => {
		try {
			switch (request.kind) {
				case "createTask":
					return await createTask(request);
				case "startTask":
					return await startTask(request);
				case "resumeTask":
					return await resumeTask(request);
			}
		} catch (error) {
			return { ok: false, error: toErrorMessage(error) };
		}
	};
}
