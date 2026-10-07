// The server side of the pipeline worker's action requests (src/pipeline/actions.ts). Each one runs through the
// code the CLI and the browser use, so a pipeline-made card is an ordinary card: board mutations under the
// workspace lock and the normal worktree + session start. `resumeTask` restarts a card restart recovery found
// orphaned or whose rework never started. (Finishing a card is the worker's `finishTask` request, the Done workflow;
// typing into one is the watchdog's `deliverInput`.)
import { randomUUID } from "node:crypto";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import { addTaskToColumn, getTaskColumnId, moveTaskToColumn, updateTask } from "../core/task-board-mutations";
import { BLOCKED_TITLE_PREFIX, type PipelineActionRequest, type PipelineActionResult } from "../pipeline/actions";
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
	/** Stops the task's session (`resumeTask` with `replaceLive`). Without it a live session is never replaced. */
	stopTaskSession?: (scope: TaskTrashWorkspaceScope, taskId: string) => Promise<void> | void;
	/** How long `replaceLive` waits for a stopped session's process to exit. Default 5 s. */
	stopTimeoutMs?: number;
	onBoardMutated?: (scope: TaskTrashWorkspaceScope) => Promise<void> | void;
	randomUuid?: () => string;
}

const STOP_POLL_MS = 100;

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function findCard(
	board: RuntimeBoardData,
	taskId: string,
): { columnId: RuntimeBoardColumnId; card: RuntimeBoardCard } | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { columnId: column.id, card };
		}
	}
	return null;
}

/** updateTask() with the card's other fields as they are. */
function replaceCardText(
	board: RuntimeBoardData,
	card: RuntimeBoardCard,
	text: { prompt?: string; title?: string },
): RuntimeBoardData | null {
	const updated = updateTask(board, card.id, {
		title: text.title ?? card.title,
		prompt: text.prompt ?? card.prompt,
		baseRef: card.baseRef,
		startInPlanMode: card.startInPlanMode,
		autoReviewEnabled: card.autoReviewEnabled === true,
		autoReviewMode: card.autoReviewMode,
		images: card.images,
	});
	return updated.updated ? updated.board : null;
}

export function createPipelineActionRunner(
	deps: PipelineActionRunnerDependencies,
): (request: PipelineActionRequest) => Promise<PipelineActionResult> {
	const randomUuid = deps.randomUuid ?? randomUUID;
	const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
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

	const updateTaskText = async (
		request: Extract<PipelineActionRequest, { kind: "updateTask" }>,
	): Promise<PipelineActionResult> => {
		const { value: error } = await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const found = findCard(state.board, request.taskId);
			if (!found || found.columnId === "trash") {
				return { board: state.board, value: `task ${request.taskId} is not on the board`, save: false };
			}
			const board = replaceCardText(state.board, found.card, { prompt: request.prompt, title: request.title });
			return board
				? { board, value: null }
				: { board: state.board, value: `task ${request.taskId} could not be updated`, save: false };
		});
		if (error) {
			return { ok: false, error };
		}
		await broadcast(request);
		return { ok: true };
	};

	/** Stops the task's live session and waits until its process is gone (a stopped PTY exits asynchronously). */
	const stopLiveSession = async (scope: TaskTrashWorkspaceScope, taskId: string): Promise<boolean> => {
		if (!deps.stopTaskSession) {
			return false;
		}
		await deps.stopTaskSession(scope, taskId);
		const deadline = Date.now() + stopTimeoutMs;
		while (await deps.hasLiveProcess?.(scope, taskId)) {
			if (Date.now() >= deadline) {
				return false;
			}
			await sleep(STOP_POLL_MS);
		}
		return true;
	};

	// Restart recovery and the rework stage: the card keeps its column until a new session is up, then goes to In
	// Progress (as resume-card did).
	const resumeTask = async (
		request: Extract<PipelineActionRequest, { kind: "resumeTask" }>,
	): Promise<PipelineActionResult> => {
		const { value: card } = await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const found = findCard(state.board, request.taskId);
			return {
				board: state.board,
				value: found && (found.columnId === "in_progress" || found.columnId === "review") ? found.card : null,
				save: false,
			};
		});
		if (!card) {
			return { ok: false, error: `task ${request.taskId} is not In Progress or in Review` };
		}
		// startTaskSession returns a live idle session unchanged (and stops an interrupted or failed one to start
		// another), so a live one is never "resumed": restart recovery leaves a card restarted by hand alone, and the
		// rework started-check (`replaceLive`) stops the session that never took the rework first.
		if (await deps.hasLiveProcess?.(request, card.id)) {
			if (!request.replaceLive) {
				return { ok: false, error: `task ${request.taskId} has a live session; not resumed` };
			}
			if (!(await stopLiveSession(request, card.id))) {
				return { ok: false, error: `task ${request.taskId}: its live session could not be stopped; not resumed` };
			}
		}
		const ensured = await deps.ensureTaskWorktree(request, { taskId: card.id, baseRef: card.baseRef });
		if (!ensured.ok) {
			return { ok: false, error: ensured.error ?? "could not set up the task worktree" };
		}
		const started = await deps.startTaskSession(request, {
			taskId: card.id,
			prompt: request.prompt ?? card.prompt.trim(),
			taskTitle: card.title,
			images: card.images,
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

	// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (blockCard): Review means "submitted
	// for QA" only (ddbc9ae), so a card that can't continue waits in Backlog as "BLOCKED: …" until someone acts.
	const blockTask = async (
		request: Extract<PipelineActionRequest, { kind: "blockTask" }>,
	): Promise<PipelineActionResult> => {
		const { value: error } = await deps.mutateWorkspaceState(request.workspacePath, (state) => {
			const found = findCard(state.board, request.taskId);
			if (!found || found.columnId === "trash") {
				return { board: state.board, value: `task ${request.taskId} is not on the board`, save: false };
			}
			let board = state.board;
			let changed = false;
			if (found.columnId === "review" || found.columnId === "in_progress") {
				const moved = moveTaskToColumn(board, found.card.id, "backlog");
				board = moved.board;
				changed = moved.moved;
			}
			const title = found.card.title ?? "";
			if (!title.startsWith(BLOCKED_TITLE_PREFIX)) {
				const retitled = replaceCardText(board, found.card, {
					title: `${BLOCKED_TITLE_PREFIX}${title}`.slice(0, 200),
				});
				if (retitled) {
					board = retitled;
					changed = true;
				}
			}
			return { board, value: null, save: changed };
		});
		if (error) {
			return { ok: false, error };
		}
		await broadcast(request);
		return { ok: true };
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
				case "updateTask":
					return await updateTaskText(request);
				case "blockTask":
					return await blockTask(request);
			}
		} catch (error) {
			return { ok: false, error: toErrorMessage(error) };
		}
	};
}
