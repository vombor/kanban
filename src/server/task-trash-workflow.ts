// The one server-side "card to Done" workflow.
//
// Every caller that finishes a task goes through `trashTask`: the CLI
// (`kanban task done|trash`), the auto-review reconciler and the browser's
// move-to-Done (through tRPC). The workflow is the only writer of the Done
// move: the browser shows it optimistically but never persists it. Before
// this module each caller ran its own copy, and the reconciler's copy only
// moved the card, so auto-review completions with no browser open left the
// session running, kept the worktree and never started the linked backlog
// tasks.
//
// Order: (optional done gate) → board move to Done → broadcast → capture the
// session process trees → stop the task and detail-terminal sessions → start
// the linked backlog tasks that became ready → reap the card's processes (its
// session trees and everything running inside its worktree, including detached
// dev servers) → delete the worktree (deleteTaskWorktree captures the patch first).
// Dependents start before the slow worktree removal, as both earlier copies
// did. The gate is the `qa` landing step (src/server/task-landing-gate.ts:
// land on the base before Done, kit-merge plan §4.2); it decides on the
// request's `landing` choice and acts only on landing-mode-`qa` workspaces.
// Every run, whatever its status, appends one line to the workspace's task history (src/state/task-history-log.ts):
// who asked (trigger, and the caller project isolation identified), from which column, the landing choice and
// outcome, the sessions stopped and whether the worktree went.

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskHistoryCaller,
	RuntimeTaskHistoryEntry,
	RuntimeTaskLandingChoice,
	RuntimeTaskLandingOutcome,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskTrashAutoStart,
	RuntimeTaskTrashRequest,
	RuntimeTaskTrashResponse,
	RuntimeTaskTrashTrigger,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getDetailTerminalTaskId } from "../core/detail-terminal-session";
import {
	getTaskColumnId,
	moveTaskToTopOfColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTaskDependencies,
} from "../core/task-board-mutations";
import { arePrerequisitesDone, getTaskPrerequisiteStatus } from "../core/task-prerequisites";
import type { RuntimeCaller } from "../isolation/session-identity";
import { startTaskHistoryCallerLookup } from "../state/task-history-log";
import type {
	RuntimeWorkspaceAtomicMutationResponse,
	RuntimeWorkspaceAtomicMutationResult,
} from "../state/workspace-state";

export type TaskTrashTrigger = RuntimeTaskTrashTrigger;

export interface TaskTrashWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface TaskTrashRequest extends TaskTrashWorkspaceScope {
	taskId: string;
	trigger: TaskTrashTrigger;
	/** Land or discard the work of a landing-mode-`qa` card (the done gate decides what it means). */
	landing?: RuntimeTaskLandingChoice;
	/**
	 * Re-checked inside the atomic board mutation. When it returns false the
	 * card is left alone and the result is `skipped` (the reconciler only
	 * completes cards that are still armed in Review).
	 */
	canTrash?: (card: RuntimeBoardCard, columnId: RuntimeBoardColumnId) => boolean;
	/** Who asked, for the task history (tRPC callers); absent = an in-process trigger. Called once, after the run. */
	resolveCaller?: () => Promise<RuntimeCaller>;
}

export type TaskTrashResult = RuntimeTaskTrashResponse;

export interface TaskDoneGateInput extends TaskTrashWorkspaceScope {
	card: RuntimeBoardCard;
	fromColumnId: RuntimeBoardColumnId;
	trigger: TaskTrashTrigger;
	landing?: RuntimeTaskLandingChoice;
}

export type TaskDoneGateDecision =
	| { proceed: true; landing?: RuntimeTaskLandingOutcome }
	| { proceed: false; reason: string; landing?: RuntimeTaskLandingOutcome };

/**
 * Runs before a card enters Done. The `qa` landing step squash-lands the task
 * onto its base here (decision 2: land first, then Done), so a land conflict
 * keeps the card in Review instead.
 */
export type TaskDoneGate = (input: TaskDoneGateInput) => Promise<TaskDoneGateDecision>;

export type MutateWorkspaceState = <T>(
	workspacePath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
) => Promise<RuntimeWorkspaceAtomicMutationResponse<T>>;

export interface CreateTaskTrashWorkflowDependencies {
	mutateWorkspaceState: MutateWorkspaceState;
	stopTaskSession: (scope: TaskTrashWorkspaceScope, taskId: string) => Promise<void>;
	deleteTaskWorktree: (scope: TaskTrashWorkspaceScope, taskId: string) => Promise<RuntimeWorktreeDeleteResponse>;
	ensureTaskWorktree: (
		scope: TaskTrashWorkspaceScope,
		input: { taskId: string; baseRef: string },
	) => Promise<RuntimeWorktreeEnsureResponse>;
	startTaskSession: (
		scope: TaskTrashWorkspaceScope,
		input: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
	/**
	 * Captures the card's session process trees; called before the sessions are stopped, while the trees are
	 * still linked. `reap` terminates them and every process inside the worktree, right before the worktree
	 * is deleted (src/server/process-reaper.ts).
	 */
	prepareProcessReap?: (scope: TaskTrashWorkspaceScope, taskId: string) => Promise<{ reap: () => Promise<unknown> }>;
	/** Broadcasts the new board to connected browsers. Awaited before sessions are stopped. */
	onBoardMutated?: (scope: TaskTrashWorkspaceScope) => Promise<void> | void;
	doneGate?: TaskDoneGate;
	/** Appends the run's task history entry (src/state/task-history-log.ts). A failure only warns. */
	recordHistory?: (entry: RuntimeTaskHistoryEntry) => Promise<void>;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface TaskTrashWorkflow {
	trashTask: (request: TaskTrashRequest) => Promise<TaskTrashResult>;
}

type BoardStepValue =
	| { kind: "not_found" }
	| { kind: "skipped"; columnId: RuntimeBoardColumnId; card: RuntimeBoardCard }
	| { kind: "already_done"; card: RuntimeBoardCard }
	| { kind: "moved"; previousColumnId: RuntimeBoardColumnId; readyTaskIds: string[]; card: RuntimeBoardCard };

/** What one run saw and did beyond its result, for the task history entry. */
interface TaskTrashTrace {
	card: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
	sessionsStopped: string[];
}

interface CardLocation {
	columnId: RuntimeBoardColumnId;
	card: RuntimeBoardCard;
}

function findCardLocation(board: RuntimeBoardData, taskId: string): CardLocation | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { columnId: column.id, card };
		}
	}
	return null;
}

function columnCanHaveLiveTaskSession(columnId: RuntimeBoardColumnId): boolean {
	return columnId === "in_progress" || columnId === "review";
}

function clearPendingGitAction(board: RuntimeBoardData, taskId: string): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => {
			if (!column.cards.some((card) => card.id === taskId && card.pendingGitAction)) {
				return column;
			}
			return {
				...column,
				cards: column.cards.map((card) => (card.id === taskId ? { ...card, pendingGitAction: null } : card)),
			};
		}),
	};
}

interface LinkedTaskClaim {
	/** The card as it was in backlog, so a failed start restores it unchanged. */
	card: RuntimeBoardCard;
	index: number;
	/** Links involving the card; leaving backlog can drop them from the board. */
	dependencies: RuntimeBoardData["dependencies"];
}

function returnTaskToBacklog(board: RuntimeBoardData, claim: LinkedTaskClaim): RuntimeBoardData {
	const taskId = claim.card.id;
	const columns = board.columns.map((column) => {
		const cards = column.cards.filter((card) => card.id !== taskId);
		if (column.id !== "backlog") {
			return cards.length === column.cards.length ? column : { ...column, cards };
		}
		const insertAt = Math.min(claim.index, cards.length);
		return { ...column, cards: [...cards.slice(0, insertAt), claim.card, ...cards.slice(insertAt)] };
	});
	const existingIds = new Set(board.dependencies.map((dependency) => dependency.id));
	const missing = claim.dependencies.filter((dependency) => !existingIds.has(dependency.id));
	// The board's link rules decide which come back, links to its Done prerequisites included.
	return updateTaskDependencies({ ...board, columns, dependencies: [...board.dependencies, ...missing] });
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createResult(
	request: TaskTrashRequest,
	status: TaskTrashResult["status"],
	overrides: Partial<TaskTrashResult> = {},
): TaskTrashResult {
	return {
		ok: status === "trashed" || status === "already_done",
		status,
		taskId: request.taskId,
		previousColumnId: null,
		readyTaskIds: [],
		autoStartedTasks: [],
		worktreeDeleted: false,
		...overrides,
	};
}

export function createTaskTrashWorkflow(deps: CreateTaskTrashWorkflowDependencies): TaskTrashWorkflow {
	const now = (): number => deps.now?.() ?? Date.now();
	// Concurrent requests for the same card (browser drag + reconciler, or a
	// double click) share one run, so cleanup and dependents happen once.
	const inFlight = new Map<string, Promise<TaskTrashResult>>();

	/** A blocked result, or the landing outcome to report once the card is Done. */
	const runDoneGate = async (
		request: TaskTrashRequest,
		trace: TaskTrashTrace,
	): Promise<{ blocked: TaskTrashResult } | { landing?: RuntimeTaskLandingOutcome }> => {
		if (!deps.doneGate) {
			return {};
		}
		const snapshot = await deps.mutateWorkspaceState(request.workspacePath, (state) => ({
			board: state.board,
			value: findCardLocation(state.board, request.taskId),
			save: false,
		}));
		const location = snapshot.value;
		if (location) {
			trace.card = location.card;
			trace.fromColumnId = location.columnId;
		}
		if (!location || location.columnId === "trash") {
			return {};
		}
		if (request.canTrash && !request.canTrash(location.card, location.columnId)) {
			return {};
		}
		const decision = await deps.doneGate({
			workspaceId: request.workspaceId,
			workspacePath: request.workspacePath,
			card: location.card,
			fromColumnId: location.columnId,
			trigger: request.trigger,
			landing: request.landing,
		});
		if (decision.proceed) {
			return { landing: decision.landing };
		}
		return {
			blocked: createResult(request, "blocked", {
				previousColumnId: location.columnId,
				error: decision.reason,
				...(decision.landing ? { landing: decision.landing } : {}),
			}),
		};
	};

	const moveCardToDone = async (request: TaskTrashRequest): Promise<BoardStepValue> => {
		const timestamp = now();
		const response = await deps.mutateWorkspaceState<BoardStepValue>(request.workspacePath, (state) => {
			const location = findCardLocation(state.board, request.taskId);
			if (!location) {
				return { board: state.board, value: { kind: "not_found" }, save: false };
			}
			if (location.columnId === "trash") {
				return { board: state.board, value: { kind: "already_done", card: location.card }, save: false };
			}
			const skipped: BoardStepValue = { kind: "skipped", columnId: location.columnId, card: location.card };
			if (request.canTrash && !request.canTrash(location.card, location.columnId)) {
				return { board: state.board, value: skipped, save: false };
			}
			const trashed = trashTaskAndGetReadyLinkedTaskIds(state.board, request.taskId, timestamp);
			if (!trashed.moved) {
				return { board: state.board, value: skipped, save: false };
			}
			return {
				board: clearPendingGitAction(trashed.board, request.taskId),
				value: {
					kind: "moved",
					previousColumnId: location.columnId,
					readyTaskIds: trashed.readyTaskIds,
					card: location.card,
				},
			};
		});
		return response.value;
	};

	const broadcast = async (scope: TaskTrashWorkspaceScope): Promise<void> => {
		try {
			await deps.onBoardMutated?.(scope);
		} catch {
			// Broadcast is best-effort; the persisted board is already correct.
		}
	};

	/** The ids of the sessions it stopped. */
	const stopSessions = async (
		request: TaskTrashRequest,
		previousColumnId: RuntimeBoardColumnId,
	): Promise<string[]> => {
		const sessionIds = [getDetailTerminalTaskId(request.taskId)];
		if (columnCanHaveLiveTaskSession(previousColumnId)) {
			sessionIds.unshift(request.taskId);
		}
		const stopped = await Promise.all(
			sessionIds.map(async (sessionId) => {
				try {
					await deps.stopTaskSession(request, sessionId);
					return sessionId;
				} catch (error) {
					deps.warn?.(`Could not stop session ${sessionId}: ${toErrorMessage(error)}`);
					return null;
				}
			}),
		);
		return stopped.filter((sessionId): sessionId is string => sessionId !== null);
	};

	const prepareProcessReap = async (request: TaskTrashRequest): Promise<() => Promise<void>> => {
		const reapFailed = (error: unknown) =>
			deps.warn?.(`Could not reap processes of task ${request.taskId}: ${toErrorMessage(error)}`);
		try {
			const prepared = await deps.prepareProcessReap?.(request, request.taskId);
			return async () => {
				await prepared?.reap().catch(reapFailed);
			};
		} catch (error) {
			reapFailed(error);
			return async () => {};
		}
	};

	const deleteWorktree = async (request: TaskTrashRequest): Promise<{ removed: boolean; error?: string }> => {
		try {
			const deleted = await deps.deleteTaskWorktree(request, request.taskId);
			return { removed: deleted.removed, error: deleted.ok ? undefined : deleted.error };
		} catch (error) {
			return { removed: false, error: toErrorMessage(error) };
		}
	};

	/**
	 * Claims a ready backlog card by moving it to In Progress inside one atomic
	 * board step, before any worktree or session work. A second Done workflow
	 * that unblocks the same card (A and B both done while C is starting) then
	 * finds it claimed and leaves it alone, so it is never launched twice.
	 */
	const claimLinkedTask = async (scope: TaskTrashWorkspaceScope, taskId: string): Promise<LinkedTaskClaim | null> => {
		const response = await deps.mutateWorkspaceState<LinkedTaskClaim | null>(scope.workspacePath, (state) => {
			const backlog = state.board.columns.find((column) => column.id === "backlog");
			const index = backlog?.cards.findIndex((card) => card.id === taskId) ?? -1;
			const card = backlog?.cards[index];
			if (!card) {
				return { board: state.board, value: null, save: false };
			}
			// Asked again under this lock: a prerequisite may have left Done since the Done step found the card ready.
			const prerequisites = getTaskPrerequisiteStatus(state.board, taskId);
			if (prerequisites && !arePrerequisitesDone(prerequisites)) {
				return { board: state.board, value: null, save: false };
			}
			// Top of In Progress, as the browser's start animation does.
			const moved = moveTaskToTopOfColumn(state.board, taskId, "in_progress", now());
			if (!moved.moved) {
				return { board: state.board, value: null, save: false };
			}
			const dependencies = state.board.dependencies.filter(
				(dependency) => dependency.fromTaskId === taskId || dependency.toTaskId === taskId,
			);
			return { board: moved.board, value: { card, index, dependencies } };
		});
		return response.value;
	};

	/** Puts a claimed card back where it was in backlog, with its links, when its start fails. */
	const releaseLinkedTask = async (scope: TaskTrashWorkspaceScope, claim: LinkedTaskClaim): Promise<void> => {
		await deps.mutateWorkspaceState(scope.workspacePath, (state) => {
			if (getTaskColumnId(state.board, claim.card.id) !== "in_progress") {
				return { board: state.board, value: null, save: false };
			}
			return { board: returnTaskToBacklog(state.board, claim), value: null };
		});
		await broadcast(scope);
	};

	const startLinkedTask = async (
		scope: TaskTrashWorkspaceScope,
		taskId: string,
	): Promise<RuntimeTaskTrashAutoStart | null> => {
		let claim: LinkedTaskClaim | null = null;
		try {
			claim = await claimLinkedTask(scope, taskId);
			if (!claim) {
				// Started already, by another Done workflow or by hand.
				return null;
			}
			// Shown right away, as the browser's optimistic start used to.
			await broadcast(scope);
			const card = claim.card;
			const ensured = await deps.ensureTaskWorktree(scope, { taskId, baseRef: card.baseRef });
			if (!ensured.ok) {
				await releaseLinkedTask(scope, claim);
				return { taskId, ok: false, error: ensured.error ?? "Could not set up task workspace." };
			}
			const started = await deps.startTaskSession(scope, {
				taskId,
				prompt: card.prompt.trim(),
				taskTitle: card.title,
				images: card.images,
				startInPlanMode: card.startInPlanMode,
				baseRef: card.baseRef,
				agentId: card.agentId,
				agentSettings: card.agentSettings,
			});
			if (!started.ok || !started.summary) {
				await releaseLinkedTask(scope, claim);
				return { taskId, ok: false, error: started.error ?? "Could not start task session." };
			}
			return { taskId, ok: true, ...(ensured.warning ? { warning: ensured.warning } : {}) };
		} catch (error) {
			if (claim) {
				await releaseLinkedTask(scope, claim).catch(() => {});
			}
			return { taskId, ok: false, error: toErrorMessage(error) };
		}
	};

	const runTrashTask = async (request: TaskTrashRequest, trace: TaskTrashTrace): Promise<TaskTrashResult> => {
		const gate = await runDoneGate(request, trace);
		if ("blocked" in gate) {
			return gate.blocked;
		}
		const landing = gate.landing ? { landing: gate.landing } : {};

		const boardStep = await moveCardToDone(request);
		if (boardStep.kind !== "not_found") {
			trace.card = boardStep.card;
			trace.fromColumnId = boardStep.kind === "moved" ? boardStep.previousColumnId : null;
		}
		if (boardStep.kind === "not_found") {
			return createResult(request, "not_found", {
				...landing,
				error: `Task "${request.taskId}" was not found in workspace ${request.workspacePath}.`,
			});
		}
		if (boardStep.kind === "skipped") {
			trace.fromColumnId = boardStep.columnId;
			return createResult(request, "skipped", { ...landing, previousColumnId: boardStep.columnId });
		}
		if (boardStep.kind === "already_done") {
			trace.fromColumnId = "trash";
			return createResult(request, "already_done", { previousColumnId: "trash" });
		}
		await broadcast(request);

		const reapProcesses = await prepareProcessReap(request);
		trace.sessionsStopped = await stopSessions(request, boardStep.previousColumnId);

		const autoStartedTasks: RuntimeTaskTrashAutoStart[] = [];
		for (const readyTaskId of boardStep.readyTaskIds) {
			const started = await startLinkedTask(request, readyTaskId);
			if (!started) {
				continue;
			}
			if (!started.ok) {
				deps.warn?.(`Could not auto-start linked task ${readyTaskId}: ${started.error ?? "unknown error"}`);
			}
			autoStartedTasks.push(started);
		}
		await reapProcesses();
		const worktree = await deleteWorktree(request);

		return createResult(request, "trashed", {
			previousColumnId: boardStep.previousColumnId,
			readyTaskIds: boardStep.readyTaskIds,
			autoStartedTasks,
			worktreeDeleted: worktree.removed,
			worktreeDeleteError: worktree.error,
			...landing,
		});
	};

	const recordHistory = async (
		request: TaskTrashRequest,
		trace: TaskTrashTrace,
		caller: Promise<RuntimeTaskHistoryCaller | null>,
		result: TaskTrashResult | null,
		failure: unknown,
	): Promise<void> => {
		if (!deps.recordHistory) {
			return;
		}
		try {
			const error = failure === undefined ? result?.error : toErrorMessage(failure);
			await deps.recordHistory({
				at: new Date(now()).toISOString(),
				action: "done",
				workspaceId: request.workspaceId,
				taskId: request.taskId,
				title: trace.card?.title ?? null,
				role: trace.card ? resolveCardRole(trace.card) : null,
				fromColumnId: trace.fromColumnId,
				trigger: request.trigger,
				caller: await caller,
				status: result?.status ?? "failed",
				landing:
					request.landing || result?.landing
						? { choice: request.landing ?? null, outcome: result?.landing ?? null }
						: null,
				sessionsStopped: trace.sessionsStopped,
				worktreeDeleted: result?.worktreeDeleted ?? false,
				...(result?.worktreeDeleteError ? { worktreeDeleteError: result.worktreeDeleteError } : {}),
				...(error ? { error } : {}),
			});
		} catch (error) {
			deps.warn?.(
				`Could not record the Done of task ${request.taskId} in the task history: ${toErrorMessage(error)}`,
			);
		}
	};

	const runAndRecord = async (request: TaskTrashRequest): Promise<TaskTrashResult> => {
		// The caller is traced through /proc when asked, so ask before any work: a card session that runs
		// `kanban task done` on its own card is gone once its sessions stop, and would read as unknown.
		const caller = startTaskHistoryCallerLookup(request.resolveCaller);
		const trace: TaskTrashTrace = { card: null, fromColumnId: null, sessionsStopped: [] };
		let result: TaskTrashResult;
		try {
			result = await runTrashTask(request, trace);
		} catch (error) {
			await recordHistory(request, trace, caller, null, error);
			throw error;
		}
		await recordHistory(request, trace, caller, result, undefined);
		return result;
	};

	return {
		trashTask: (request) => {
			const key = `${request.workspaceId}\u0000${request.taskId}`;
			const existing = inFlight.get(key);
			if (existing) {
				return existing;
			}
			const run = runAndRecord(request).finally(() => {
				inFlight.delete(key);
			});
			inFlight.set(key, run);
			return run;
		},
	};
}

/** Adapts the tRPC `workspace.trashTask` request (CLI and browser callers) to the workflow. */
export function createTrashTaskRequestHandler(
	workflow: TaskTrashWorkflow,
): (
	scope: TaskTrashWorkspaceScope,
	input: RuntimeTaskTrashRequest,
	resolveCaller?: () => Promise<RuntimeCaller>,
) => Promise<TaskTrashResult> {
	return async (scope, input, resolveCaller) =>
		await workflow.trashTask({
			workspaceId: scope.workspaceId,
			workspacePath: scope.workspacePath,
			taskId: input.taskId,
			trigger: input.trigger ?? "cli",
			landing: input.landing,
			resolveCaller,
		});
}
