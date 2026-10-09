import { TRPCError } from "@trpc/server";
import type {
	RuntimeDevAssignmentResponse,
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeTaskHistoryEntry,
	RuntimeTaskHistoryResponse,
	RuntimeTaskTrashRequest,
	RuntimeTaskTrashResponse,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeDeleteResponse,
} from "../core/api-contract";
import {
	parseGitCheckoutRequest,
	parseTaskTrashRequest,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core/api-validation";
import { getDetailTerminalTaskId } from "../core/detail-terminal-session";
import type { RuntimeCaller } from "../isolation/session-identity";
import { recordBrowserDevAssignments } from "../kits/browser-dev-assignment-log";
import { listWorkspaceVettedCombinations } from "../kits/card-routing-check";
import { resolveDevAssignment } from "../kits/dev-assignment";
import { findOrchestratorWait } from "../server/orchestrator-wait";
import type { PreparedWorktreeReap } from "../server/process-reaper";
import { appendTaskHistory, readTaskHistory, startTaskHistoryCallerLookup } from "../state/task-history-log";
import { saveWorkspaceStateReportingAddedCards, WorkspaceStateConflictError } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef,
} from "../workspace/get-workspace-changes";
import { getCommitDiff, getGitLog, getGitRefs } from "../workspace/git-history";
import { discardGitChanges, getGitSyncSummary, runGitCheckoutAction, runGitSyncAction } from "../workspace/git-sync";
import { searchWorkspaceFiles } from "../workspace/search-workspace-files";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo,
	resolveTaskCwd,
} from "../workspace/task-worktree";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateWorkspaceApiDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	/** The server-side Done workflow (src/server/task-trash-workflow.ts). */
	trashTask: (
		scope: { workspaceId: string; workspacePath: string },
		input: RuntimeTaskTrashRequest,
		resolveCaller?: () => Promise<RuntimeCaller>,
	) => Promise<RuntimeTaskTrashResponse>;
	/** Appends a task delete to the task history; default the home's log (src/state/task-history-log.ts). */
	recordTaskHistory?: (entry: RuntimeTaskHistoryEntry) => Promise<void>;
	/** Reads the task history; default the home's log. */
	readTaskHistory?: typeof readTaskHistory;
	now?: () => number;
	/** Process reaping before the worktree is deleted (src/server/process-reaper.ts). */
	prepareTaskProcessReap?: (
		scope: { workspaceId: string; workspacePath: string },
		taskId: string,
	) => Promise<PreparedWorktreeReap>;
}

function normalizeOptionalTaskWorkspaceScopeInput(
	input: { taskId: string; baseRef: string } | null,
): { taskId: string; baseRef: string } | null {
	if (!input) {
		return null;
	}
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId || !baseRef) {
		throw new Error("baseRef query parameter requires taskId.");
	}
	return {
		taskId,
		baseRef,
	};
}

function normalizeRequiredTaskWorkspaceScopeInput(input: {
	taskId: string;
	baseRef: string;
	mode?: RuntimeWorkspaceChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkspaceChangesMode;
} {
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId) {
		throw new Error("Missing taskId query parameter.");
	}
	if (!baseRef) {
		throw new Error("Missing baseRef query parameter.");
	}
	const mode: RuntimeWorkspaceChangesMode = input.mode ?? "working_copy";
	return {
		taskId,
		baseRef,
		mode,
	};
}

function createEmptyGitSummaryErrorResponse(error: unknown): RuntimeGitSummaryResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		error: message,
	};
}

function createEmptyGitSyncErrorResponse(action: RuntimeGitSyncAction, error: unknown): RuntimeGitSyncResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		action,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitCheckoutErrorResponse(error: unknown): RuntimeGitCheckoutResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		branch: "",
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function createEmptyGitDiscardErrorResponse(error: unknown): RuntimeGitDiscardResponse {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		summary: {
			currentBranch: null,
			upstreamBranch: null,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			aheadCount: 0,
			behindCount: 0,
		},
		output: "",
		error: message,
	};
}

function isMissingTaskWorktreeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.message.startsWith("Task worktree not found for task ");
}

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	const recordTaskHistory = deps.recordTaskHistory ?? (async (entry) => await appendTaskHistory(entry));
	return {
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let summaryCwd = workspaceScope.workspacePath;
				if (taskScope) {
					summaryCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const summary = await getGitSyncSummary(summaryCwd);
				return {
					ok: true,
					summary,
				} satisfies RuntimeGitSummaryResponse;
			} catch (error) {
				return createEmptyGitSummaryErrorResponse(error);
			}
		},
		runGitSyncAction: async (workspaceScope, input) => {
			try {
				return await runGitSyncAction({
					cwd: workspaceScope.workspacePath,
					action: input.action,
				});
			} catch (error) {
				return createEmptyGitSyncErrorResponse(input.action, error);
			}
		},
		checkoutGitBranch: async (workspaceScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);
				const response = await runGitCheckoutAction({
					cwd: workspaceScope.workspacePath,
					branch: body.branch,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitCheckoutErrorResponse(error);
			}
		},
		discardGitChanges: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				let discardCwd = workspaceScope.workspacePath;
				if (taskScope) {
					discardCwd = await resolveTaskCwd({
						cwd: workspaceScope.workspacePath,
						taskId: taskScope.taskId,
						baseRef: taskScope.baseRef,
						ensure: false,
					});
				}
				const response = await discardGitChanges({
					cwd: discardCwd,
				});
				if (response.ok) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(
						workspaceScope.workspaceId,
						workspaceScope.workspacePath,
					);
				}
				return response;
			} catch (error) {
				return createEmptyGitDiscardErrorResponse(error);
			}
		},
		loadChanges: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			let taskCwd: string;
			try {
				taskCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: normalizedInput.taskId,
					baseRef: normalizedInput.baseRef,
					ensure: false,
				});
			} catch (error) {
				if (!isMissingTaskWorktreeError(error)) {
					throw error;
				}
				return await createEmptyWorkspaceChangesResponse(workspaceScope.workspacePath);
			}
			if (normalizedInput.mode === "last_turn") {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				const summary = terminalManager.getSummary(normalizedInput.taskId);
				const fromCheckpoint = summary?.previousTurnCheckpoint;
				const toCheckpoint = summary?.latestTurnCheckpoint;
				if (!toCheckpoint) {
					return await createEmptyWorkspaceChangesResponse(taskCwd);
				}
				if (summary?.state === "running" || !fromCheckpoint) {
					return await getWorkspaceChangesFromRef({
						cwd: taskCwd,
						fromRef: toCheckpoint.commit,
					});
				}
				return await getWorkspaceChangesBetweenRefs({
					cwd: taskCwd,
					fromRef: fromCheckpoint.commit,
					toRef: toCheckpoint.commit,
				});
			}
			return await getWorkspaceChanges(taskCwd);
		},
		ensureWorktree: async (workspaceScope, input) => {
			const body = parseWorktreeEnsureRequest(input);
			return await ensureTaskWorktreeIfDoesntExist({
				cwd: workspaceScope.workspacePath,
				taskId: body.taskId,
				baseRef: body.baseRef,
			});
		},
		// A task delete's cleanup (`kanban task delete`, the browser's Clear Done; the caller removed the card from
		// the board first): capture the session trees, stop the task's sessions, reap, delete the worktree, and log it.
		deleteWorktree: async (workspaceScope, input, resolveCaller) => {
			const body = parseWorktreeDeleteRequest(input);
			// Before any stop: a card session deleting its own card is gone afterwards (startTaskHistoryCallerLookup).
			const caller = startTaskHistoryCallerLookup(resolveCaller);
			let reap: PreparedWorktreeReap | undefined;
			try {
				reap = await deps.prepareTaskProcessReap?.(workspaceScope, body.taskId);
			} catch {
				// Best effort: the orphan sweeper finds anything left once the worktree is gone.
			}
			const sessionsStopped: string[] = [];
			try {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				for (const sessionId of [body.taskId, getDetailTerminalTaskId(body.taskId)]) {
					if (terminalManager.hasLiveProcess(sessionId)) {
						terminalManager.stopTaskSession(sessionId);
						sessionsStopped.push(sessionId);
					}
				}
			} catch {
				// Best effort, as the reap: the delete goes ahead.
			}
			await reap?.reap().catch(() => {});
			let deleted: RuntimeWorktreeDeleteResponse;
			try {
				deleted = await deleteTaskWorktree({
					repoPath: workspaceScope.workspacePath,
					taskId: body.taskId,
				});
			} catch (error) {
				deleted = { ok: false, removed: false, error: error instanceof Error ? error.message : String(error) };
			}
			try {
				await recordTaskHistory({
					at: new Date(deps.now?.() ?? Date.now()).toISOString(),
					action: "delete",
					workspaceId: workspaceScope.workspaceId,
					taskId: body.taskId,
					title: body.title ?? null,
					role: body.role ?? null,
					fromColumnId: body.fromColumnId ?? null,
					trigger: body.trigger ?? "cli",
					caller: await caller,
					status: deleted.ok ? "deleted" : "failed",
					landing: null,
					sessionsStopped,
					worktreeDeleted: deleted.removed,
					...(deleted.error ? { worktreeDeleteError: deleted.error } : {}),
				});
			} catch {
				// The history is diagnostics; a failed write never fails the delete.
			}
			return deleted;
		},
		trashTask: async (workspaceScope, input, resolveCaller) => {
			const body = parseTaskTrashRequest(input);
			try {
				return await deps.trashTask(workspaceScope, body, resolveCaller);
			} catch (error) {
				return {
					ok: false,
					status: "failed",
					taskId: body.taskId,
					previousColumnId: null,
					readyTaskIds: [],
					autoStartedTasks: [],
					worktreeDeleted: false,
					error: error instanceof Error ? error.message : String(error),
				} satisfies RuntimeTaskTrashResponse;
			}
		},
		loadTaskHistory: async (workspaceScope, input): Promise<RuntimeTaskHistoryResponse> =>
			await (deps.readTaskHistory ?? readTaskHistory)(workspaceScope.workspaceId, {
				taskId: input?.taskId?.trim() || undefined,
				limit: input?.limit,
			}),
		loadTaskContext: async (workspaceScope, input) => {
			const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
			return await getTaskWorkspaceInfo({
				cwd: workspaceScope.workspacePath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
			});
		},
		loadDevAssignment: async (workspaceScope, input) => {
			// The browser's create dialog preselects an `applied` proposal; the creator can still change it.
			const decision = await resolveDevAssignment({
				workspaceId: workspaceScope.workspaceId,
				title: input?.title ?? "",
				prompt: input?.prompt ?? "",
			});
			return {
				kitName: decision.kitName,
				outcome: decision.outcome,
				proposal: decision.proposal,
				vettedDev: await listWorkspaceVettedCombinations(workspaceScope.workspaceId, "dev"),
			} satisfies RuntimeDevAssignmentResponse;
		},
		searchFiles: async (workspaceScope, input) => {
			const query = input.query.trim();
			const limit = input.limit;
			const files = await searchWorkspaceFiles(workspaceScope.workspacePath, query, limit);
			return {
				query,
				files,
			} satisfies RuntimeWorkspaceFileSearchResponse;
		},
		loadState: async (workspaceScope) => {
			return await deps.buildWorkspaceStateSnapshot(workspaceScope.workspaceId, workspaceScope.workspacePath);
		},
		loadOrchestratorWait: async (workspaceScope) => {
			const terminalManager = await deps.ensureTerminalManagerForWorkspace(
				workspaceScope.workspaceId,
				workspaceScope.workspacePath,
			);
			return { wait: findOrchestratorWait(terminalManager, workspaceScope.workspaceId) };
		},
		notifyStateUpdated: async (workspaceScope) => {
			void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
			void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
			return {
				ok: true,
			};
		},
		saveState: async (workspaceScope, input) => {
			try {
				const terminalManager = await deps.ensureTerminalManagerForWorkspace(
					workspaceScope.workspaceId,
					workspaceScope.workspacePath,
				);
				for (const summary of terminalManager.listSummaries()) {
					input.sessions[summary.taskId] = summary;
				}
				const { state: response, addedCards } = await saveWorkspaceStateReportingAddedCards(
					workspaceScope.workspacePath,
					input,
				);
				// The browser builds new cards itself, so the server logs their dev assignment (the CLI logs its own).
				void recordBrowserDevAssignments(workspaceScope.workspaceId, addedCards);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
				void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
				return response;
			} catch (error) {
				if (error instanceof WorkspaceStateConflictError) {
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: {
							currentRevision: error.currentRevision,
						},
					});
				}
				throw error;
			}
		},
		loadWorkspaceChanges: async (workspaceScope) => {
			return await getWorkspaceChanges(workspaceScope.workspacePath);
		},
		loadGitLog: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let logCwd = workspaceScope.workspacePath;
			if (taskScope) {
				logCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitLog({
				cwd: logCwd,
				ref: input.ref ?? null,
				refs: input.refs ?? null,
				maxCount: input.maxCount,
				skip: input.skip,
			});
		},
		loadGitRefs: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input ?? null);
			let refsCwd = workspaceScope.workspacePath;
			if (taskScope) {
				refsCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getGitRefs(refsCwd);
		},
		loadCommitDiff: async (workspaceScope, input) => {
			const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null);
			let diffCwd = workspaceScope.workspacePath;
			if (taskScope) {
				diffCwd = await resolveTaskCwd({
					cwd: workspaceScope.workspacePath,
					taskId: taskScope.taskId,
					baseRef: taskScope.baseRef,
					ensure: false,
				});
			}
			return await getCommitDiff({
				cwd: diffCwd,
				commitHash: input.commitHash,
			});
		},
	};
}
