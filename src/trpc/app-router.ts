// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import type {
	RuntimeConfigResponse,
	RuntimeConfigSaveRequest,
	RuntimeDebugResetAllStateResponse,
	RuntimeDevAssignmentRequest,
	RuntimeDevAssignmentResponse,
	RuntimeDirectoryListRequest,
	RuntimeDirectoryListResponse,
	RuntimeGitCheckoutRequest,
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitDiffRequest,
	RuntimeGitCommitDiffResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitLogRequest,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimeOrchestratorWaitResponse,
	RuntimeProcessSweepResponse,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectCreateRequest,
	RuntimeProjectCreateResponse,
	RuntimeProjectDirectoryPickerResponse,
	RuntimeProjectNameCheckRequest,
	RuntimeProjectNameCheckResponse,
	RuntimeProjectRemoveRequest,
	RuntimeProjectRemoveResponse,
	RuntimeProjectRootsResponse,
	RuntimeProjectsResponse,
	RuntimeRunUpdateResponse,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeTaskHistoryRequest,
	RuntimeTaskHistoryResponse,
	RuntimeTaskInputDeliveryRequest,
	RuntimeTaskInputDeliveryResponse,
	RuntimeTaskSessionInputRequest,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopRequest,
	RuntimeTaskSessionStopResponse,
	RuntimeTaskTrashRequest,
	RuntimeTaskTrashResponse,
	RuntimeTaskWorkspaceInfoRequest,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeUpdateStatusResponse,
	RuntimeWorkspaceChangesRequest,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileSearchRequest,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateNotifyResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
	RuntimeWorktreeDeleteRequest,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureRequest,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import {
	runtimeConfigResponseSchema,
	runtimeConfigSaveRequestSchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeDevAssignmentRequestSchema,
	runtimeDevAssignmentResponseSchema,
	runtimeDirectoryListRequestSchema,
	runtimeDirectoryListResponseSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeGitCheckoutResponseSchema,
	runtimeGitCommitDiffRequestSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitDiscardResponseSchema,
	runtimeGitLogRequestSchema,
	runtimeGitLogResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncActionSchema,
	runtimeGitSyncResponseSchema,
	runtimeHookIngestRequestSchema,
	runtimeHookIngestResponseSchema,
	runtimeOpenFileRequestSchema,
	runtimeOpenFileResponseSchema,
	runtimeOrchestratorWaitResponseSchema,
	runtimeProcessSweepResponseSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectAddResponseSchema,
	runtimeProjectCreateRequestSchema,
	runtimeProjectCreateResponseSchema,
	runtimeProjectDirectoryPickerResponseSchema,
	runtimeProjectNameCheckRequestSchema,
	runtimeProjectNameCheckResponseSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeProjectRemoveResponseSchema,
	runtimeProjectRootsResponseSchema,
	runtimeProjectsResponseSchema,
	runtimeRunUpdateResponseSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeTaskHistoryRequestSchema,
	runtimeTaskHistoryResponseSchema,
	runtimeTaskInputDeliveryRequestSchema,
	runtimeTaskInputDeliveryResponseSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionInputResponseSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStartResponseSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskSessionStopResponseSchema,
	runtimeTaskTrashRequestSchema,
	runtimeTaskTrashResponseSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeUpdateStatusResponseSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceChangesResponseSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceFileSearchResponseSchema,
	runtimeWorkspaceStateNotifyResponseSchema,
	runtimeWorkspaceStateResponseSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureRequestSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../core/api-contract";
import { isHomeAgentSessionId, isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import type { CallerRequest } from "../isolation/isolation-service";
import type { RuntimeCaller } from "../isolation/session-identity";
import {
	githubAppStartRequestSchema,
	githubAppStartResponseSchema,
	githubAppStatusResponseSchema,
	githubIssueRequestSchema,
	githubIssueResponseSchema,
	type RuntimeGitHubApi,
} from "./github-api";
import {
	isolationApprovalRequestResponseSchema,
	isolationApprovalRequestSchema,
	isolationApprovalStatusResponseSchema,
	isolationApproveRequestSchema,
	isolationApproveResponseSchema,
	isolationBindChildCredentialRequestSchema,
	isolationChildCredentialResponseSchema,
	isolationGrantRequestSchema,
	isolationGrantResponseSchema,
	isolationGrantsResponseSchema,
	isolationRevokeRequestSchema,
	isolationWhoamiResponseSchema,
	messageInboxRequestSchema,
	messageInboxResponseSchema,
	messageSendRequestSchema,
	messageSendResponseSchema,
	type RuntimeIsolationApi,
} from "./isolation-api";
import {
	kitSettingChangeResponseSchema,
	kitSettingSetRequestSchema,
	kitSettingUnsetRequestSchema,
	type RuntimeKitSettingsApi,
} from "./kit-settings-api";
import {
	type RuntimePipelineResubmitApi,
	taskResubmitRequestSchema,
	taskResubmitResponseSchema,
} from "./pipeline-resubmit-api";
import {
	planApproveRequestSchema,
	planApproveResponseSchema,
	planPreviewRequestSchema,
	planPreviewResponseSchema,
	type RuntimePlansApi,
} from "./plans-api";
import {
	type RuntimeShortcutsApi,
	shortcutAddRequestSchema,
	shortcutChangeResponseSchema,
	shortcutListResponseSchema,
	shortcutPrepareRunRequestSchema,
	shortcutPrepareRunResponseSchema,
	shortcutRemoveRequestSchema,
} from "./shortcuts-api";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	/**
	 * Who is calling (src/isolation/session-identity.ts): an agent session (its credential, or traced to its process
	 * tree) or the user. Absent = the user (in-process callers, tests).
	 */
	caller?: RuntimeCaller;
	/**
	 * Resolves the caller on first use (the /proc lookup costs a scan, and hot paths like hooks.ingest never need
	 * it); wins over `caller`.
	 */
	getCaller?: () => Promise<RuntimeCaller>;
	/** The raw request for the isolation service's own lookups (child credentials); absent in-process. */
	callerRequest?: CallerRequest;
	/** The caller with the process-tree lookup forced on, for grants, approvals and project changes. */
	resolveStrictCaller?: () => Promise<RuntimeCaller>;
	/** A passcode-authenticated browser session (remote mode): the user, so project changes need no approval. */
	trustedBrowser?: boolean;
	/** Project isolation's checks and procedures (src/trpc/isolation-api.ts); absent = no checks. */
	isolationApi?: RuntimeIsolationApi;
	/** Plan approval (src/trpc/plans-api.ts); absent = not available. */
	plansApi?: RuntimePlansApi;
	/** A project's settings on its kit (src/trpc/kit-settings-api.ts); absent = not available. */
	kitSettingsApi?: RuntimeKitSettingsApi;
	/** A project's shortcuts from the CLI, and a run's port (src/trpc/shortcuts-api.ts); absent = not available. */
	shortcutsApi?: RuntimeShortcutsApi;
	/** GitHub issues and comments as the Kanban GitHub App (src/trpc/github-api.ts); absent = not available. */
	githubApi?: RuntimeGitHubApi;
	/** `kanban task resubmit` (src/trpc/pipeline-resubmit-api.ts); absent = not available. */
	pipelineResubmitApi?: RuntimePipelineResubmitApi;
	runtimeApi: {
		loadConfig: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		sendTaskSessionInput: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionInputRequest,
		) => Promise<RuntimeTaskSessionInputResponse>;
		deliverTaskInput: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskInputDeliveryRequest,
		) => Promise<RuntimeTaskInputDeliveryResponse>;
		startShellSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeShellSessionStartRequest,
		) => Promise<RuntimeShellSessionStartResponse>;
		resetAllState: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeDebugResetAllStateResponse>;
		openFile: (input: RuntimeOpenFileRequest) => Promise<RuntimeOpenFileResponse>;
		getUpdateStatus: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeUpdateStatusResponse>;
		runUpdateNow: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeRunUpdateResponse>;
		getProcessSweep: () => Promise<RuntimeProcessSweepResponse>;
		runProcessSweep: () => Promise<RuntimeProcessSweepResponse>;
	};
	workspaceApi: {
		loadGitSummary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitSummaryResponse>;
		runGitSyncAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { action: RuntimeGitSyncAction },
		) => Promise<RuntimeGitSyncResponse>;
		checkoutGitBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCheckoutRequest,
		) => Promise<RuntimeGitCheckoutResponse>;
		discardGitChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitDiscardResponse>;
		loadChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceChangesRequest,
		) => Promise<RuntimeWorkspaceChangesResponse>;
		ensureWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeEnsureRequest,
		) => Promise<RuntimeWorktreeEnsureResponse>;
		/** `resolveCaller`: who asked, for the task history (called once, after the work). */
		deleteWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeDeleteRequest,
			resolveCaller?: () => Promise<RuntimeCaller>,
		) => Promise<RuntimeWorktreeDeleteResponse>;
		trashTask: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskTrashRequest,
			resolveCaller?: () => Promise<RuntimeCaller>,
		) => Promise<RuntimeTaskTrashResponse>;
		loadTaskHistory: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskHistoryRequest | undefined,
		) => Promise<RuntimeTaskHistoryResponse>;
		loadTaskContext: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest,
		) => Promise<RuntimeTaskWorkspaceInfoResponse>;
		loadDevAssignment: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDevAssignmentRequest | undefined,
		) => Promise<RuntimeDevAssignmentResponse>;
		searchFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceFileSearchRequest,
		) => Promise<RuntimeWorkspaceFileSearchResponse>;
		loadState: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateResponse>;
		loadOrchestratorWait: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeOrchestratorWaitResponse>;
		notifyStateUpdated: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateNotifyResponse>;
		saveState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceStateSaveRequest,
		) => Promise<RuntimeWorkspaceStateResponse>;
		loadWorkspaceChanges: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceChangesResponse>;
		loadGitLog: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeGitLogRequest) => Promise<RuntimeGitLogResponse>;
		loadGitRefs: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitRefsResponse>;
		loadCommitDiff: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitDiffRequest,
		) => Promise<RuntimeGitCommitDiffResponse>;
	};
	projectsApi: {
		listProjects: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectsResponse>;
		addProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectAddRequest,
		) => Promise<RuntimeProjectAddResponse>;
		removeProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectRemoveRequest,
		) => Promise<RuntimeProjectRemoveResponse>;
		createProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectCreateRequest,
		) => Promise<RuntimeProjectCreateResponse>;
		getProjectRoots: () => Promise<RuntimeProjectRootsResponse>;
		checkProjectName: (input: RuntimeProjectNameCheckRequest) => Promise<RuntimeProjectNameCheckResponse>;
		pickProjectDirectory: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectDirectoryPickerResponse>;
		listDirectoryContents: (
			preferredWorkspaceId: string | null,
			input: RuntimeDirectoryListRequest,
		) => Promise<RuntimeDirectoryListResponse>;
	};
	hooksApi: {
		ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	};
}

interface RuntimeTrpcContextWithWorkspaceScope extends RuntimeTrpcContext {
	workspaceScope: RuntimeTrpcWorkspaceScope;
}

function readConflictRevision(cause: unknown): number | null {
	if (!cause || typeof cause !== "object" || !("currentRevision" in cause)) {
		return null;
	}
	const revision = (cause as { currentRevision?: unknown }).currentRevision;
	if (typeof revision !== "number") {
		return null;
	}
	return Number.isFinite(revision) ? revision : null;
}

const t = initTRPC.context<RuntimeTrpcContext>().create({
	errorFormatter({ shape, error }) {
		const conflictRevision = error.code === "CONFLICT" ? readConflictRevision(error.cause) : null;
		return {
			...shape,
			data: {
				...shape.data,
				conflictRevision,
			},
		};
	},
});

function forbidden(message: string): TRPCError {
	return new TRPCError({ code: "FORBIDDEN", message });
}

const USER: RuntimeCaller = { kind: "user" };

async function readCaller(ctx: RuntimeTrpcContext): Promise<RuntimeCaller> {
	return ctx.getCaller ? await ctx.getCaller() : (ctx.caller ?? USER);
}

async function readStrictCaller(ctx: RuntimeTrpcContext): Promise<RuntimeCaller> {
	return ctx.resolveStrictCaller ? await ctx.resolveStrictCaller() : await readCaller(ctx);
}

/** Refuses a machine-wide operation from an agent session under project isolation `enforce`. */
async function assertMachineAction(ctx: RuntimeTrpcContext, action: string): Promise<void> {
	if (!ctx.isolationApi) {
		return;
	}
	const decision = await ctx.isolationApi.checkMachineAction(await readCaller(ctx), action);
	if (!decision.allowed) {
		throw forbidden(decision.message);
	}
}

/**
 * Refuses a project create/add/remove from an agent session (always, whatever the isolation mode). While some
 * workspace is in enforce, anyone else's change waits for the console-code approval, which then runs `run`.
 */
async function assertProjectChange(
	ctx: RuntimeTrpcContext,
	kind: "create" | "add" | "remove",
	target: { path?: string | null; workspaceId?: string | null },
	run: () => Promise<string>,
): Promise<void> {
	if (!ctx.isolationApi) {
		return;
	}
	// Whatever the mode, a session without its credential is traced to its process tree here.
	const decision = await ctx.isolationApi.checkProjectChange({
		caller: await readStrictCaller(ctx),
		kind,
		target,
		action: `projects.${kind}`,
		trustedBrowser: ctx.trustedBrowser === true,
		run,
	});
	if (!decision.allowed) {
		throw forbidden(decision.message);
	}
}

const workspaceProcedure = t.procedure.use(async ({ ctx, next, path }) => {
	if (!ctx.requestedWorkspaceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Missing workspace scope. Include x-kanban-workspace-id header or workspaceId query parameter.",
		});
	}
	if (!ctx.workspaceScope) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Unknown workspace ID: ${ctx.requestedWorkspaceId}`,
		});
	}
	// Project isolation: a session reaches only its own workspace (and the ones the user granted it).
	if (ctx.isolationApi) {
		const decision = await ctx.isolationApi.checkWorkspaceAccess(
			await readCaller(ctx),
			ctx.workspaceScope.workspaceId,
			path,
		);
		if (decision.outcome === "refuse") {
			throw forbidden(decision.message);
		}
	}
	return next({
		ctx: {
			...ctx,
			workspaceScope: ctx.workspaceScope,
		} satisfies RuntimeTrpcContextWithWorkspaceScope,
	});
});

const optionalTaskWorkspaceInfoRequestSchema = runtimeTaskWorkspaceInfoRequestSchema.nullable().optional();
const gitSyncActionInputSchema = z.object({
	action: runtimeGitSyncActionSchema,
});

export const runtimeAppRouter = t.router({
	runtime: t.router({
		getConfig: t.procedure.output(runtimeConfigResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.loadConfig(ctx.workspaceScope);
		}),
		saveConfig: t.procedure
			.input(runtimeConfigSaveRequestSchema)
			.output(runtimeConfigResponseSchema)
			.mutation(async ({ ctx, input }) => {
				// The runtime config's agent and prompt settings are machine-wide (config.json).
				await assertMachineAction(ctx, "runtime.saveConfig");
				return await ctx.runtimeApi.saveConfig(ctx.workspaceScope, input);
			}),
		startTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStartRequestSchema)
			.output(runtimeTaskSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startTaskSession(ctx.workspaceScope, input);
			}),
		stopTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStopRequestSchema)
			.output(runtimeTaskSessionStopResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.stopTaskSession(ctx.workspaceScope, input);
			}),
		sendTaskSessionInput: workspaceProcedure
			.input(runtimeTaskSessionInputRequestSchema)
			.output(runtimeTaskSessionInputResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskSessionInput(ctx.workspaceScope, input);
			}),
		// Typed input with delivery confirmation (focus-in, separate Enter, activity check and retry).
		deliverTaskInput: workspaceProcedure
			.input(runtimeTaskInputDeliveryRequestSchema)
			.output(runtimeTaskInputDeliveryResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.deliverTaskInput(ctx.workspaceScope, input);
			}),
		startShellSession: workspaceProcedure
			.input(runtimeShellSessionStartRequestSchema)
			.output(runtimeShellSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startShellSession(ctx.workspaceScope, input);
			}),
		resetAllState: t.procedure.output(runtimeDebugResetAllStateResponseSchema).mutation(async ({ ctx }) => {
			await assertMachineAction(ctx, "runtime.resetAllState");
			return await ctx.runtimeApi.resetAllState(ctx.workspaceScope);
		}),
		openFile: t.procedure
			.input(runtimeOpenFileRequestSchema)
			.output(runtimeOpenFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.openFile(input);
			}),
		getUpdateStatus: t.procedure.output(runtimeUpdateStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getUpdateStatus(ctx.workspaceScope);
		}),
		runUpdateNow: t.procedure.output(runtimeRunUpdateResponseSchema).mutation(async ({ ctx }) => {
			await assertMachineAction(ctx, "runtime.runUpdateNow");
			return await ctx.runtimeApi.runUpdateNow(ctx.workspaceScope);
		}),
		// Process hygiene: the last orphan sweep, and a sweep on demand (debug dialog).
		getProcessSweep: t.procedure.output(runtimeProcessSweepResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getProcessSweep();
		}),
		runProcessSweep: t.procedure.output(runtimeProcessSweepResponseSchema).mutation(async ({ ctx }) => {
			await assertMachineAction(ctx, "runtime.runProcessSweep");
			return await ctx.runtimeApi.runProcessSweep();
		}),
	}),
	workspace: t.router({
		getGitSummary: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitSummaryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitSummary(ctx.workspaceScope, input ?? null);
			}),
		runGitSyncAction: workspaceProcedure
			.input(gitSyncActionInputSchema)
			.output(runtimeGitSyncResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.runGitSyncAction(ctx.workspaceScope, input);
			}),
		checkoutGitBranch: workspaceProcedure
			.input(runtimeGitCheckoutRequestSchema)
			.output(runtimeGitCheckoutResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.checkoutGitBranch(ctx.workspaceScope, input);
			}),
		discardGitChanges: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitDiscardResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.discardGitChanges(ctx.workspaceScope, input ?? null);
			}),
		getChanges: workspaceProcedure
			.input(runtimeWorkspaceChangesRequestSchema)
			.output(runtimeWorkspaceChangesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadChanges(ctx.workspaceScope, input);
			}),
		ensureWorktree: workspaceProcedure
			.input(runtimeWorktreeEnsureRequestSchema)
			.output(runtimeWorktreeEnsureResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.ensureWorktree(ctx.workspaceScope, input);
			}),
		deleteWorktree: workspaceProcedure
			.input(runtimeWorktreeDeleteRequestSchema)
			.output(runtimeWorktreeDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteWorktree(ctx.workspaceScope, input, () => readStrictCaller(ctx));
			}),
		trashTask: workspaceProcedure
			.input(runtimeTaskTrashRequestSchema)
			.output(runtimeTaskTrashResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.trashTask(ctx.workspaceScope, input, () => readStrictCaller(ctx));
			}),
		// Every Done move and task delete of the workspace (src/state/task-history-log.ts), oldest first.
		getTaskHistory: workspaceProcedure
			.input(runtimeTaskHistoryRequestSchema.optional())
			.output(runtimeTaskHistoryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadTaskHistory(ctx.workspaceScope, input);
			}),
		getTaskContext: workspaceProcedure
			.input(runtimeTaskWorkspaceInfoRequestSchema)
			.output(runtimeTaskWorkspaceInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadTaskContext(ctx.workspaceScope, input);
			}),
		getDevAssignment: workspaceProcedure
			.input(runtimeDevAssignmentRequestSchema.optional())
			.output(runtimeDevAssignmentResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadDevAssignment(ctx.workspaceScope, input);
			}),
		searchFiles: workspaceProcedure
			.input(runtimeWorkspaceFileSearchRequestSchema)
			.output(runtimeWorkspaceFileSearchResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.searchFiles(ctx.workspaceScope, input);
			}),
		getState: workspaceProcedure.output(runtimeWorkspaceStateResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadState(ctx.workspaceScope);
		}),
		// What the project's orchestrator asks the user (the project summaries say only that it waits).
		getOrchestratorWait: workspaceProcedure.output(runtimeOrchestratorWaitResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadOrchestratorWait(ctx.workspaceScope);
		}),
		notifyStateUpdated: workspaceProcedure
			.output(runtimeWorkspaceStateNotifyResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.workspaceApi.notifyStateUpdated(ctx.workspaceScope);
			}),
		saveState: workspaceProcedure
			.input(runtimeWorkspaceStateSaveRequestSchema)
			.output(runtimeWorkspaceStateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.saveState(ctx.workspaceScope, input);
			}),
		getWorkspaceChanges: workspaceProcedure.output(runtimeWorkspaceChangesResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadWorkspaceChanges(ctx.workspaceScope);
		}),
		getGitLog: workspaceProcedure
			.input(runtimeGitLogRequestSchema)
			.output(runtimeGitLogResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitLog(ctx.workspaceScope, input);
			}),
		getGitRefs: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitRefsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitRefs(ctx.workspaceScope, input ?? null);
			}),
		getCommitDiff: workspaceProcedure
			.input(runtimeGitCommitDiffRequestSchema)
			.output(runtimeGitCommitDiffResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadCommitDiff(ctx.workspaceScope, input);
			}),
	}),
	projects: t.router({
		list: t.procedure.output(runtimeProjectsResponseSchema).query(async ({ ctx }) => {
			const response = await ctx.projectsApi.listProjects(ctx.requestedWorkspaceId);
			const caller = ctx.isolationApi ? await readCaller(ctx) : USER;
			if (!ctx.isolationApi || caller.kind === "user") {
				return response;
			}
			// A session only sees the projects isolation lets it reach.
			const visible = await ctx.isolationApi.filterVisibleWorkspaceIds(
				caller,
				response.projects.map((project) => project.id),
			);
			return {
				currentProjectId:
					response.currentProjectId && visible.has(response.currentProjectId) ? response.currentProjectId : null,
				projects: response.projects.filter((project) => visible.has(project.id)),
			};
		}),
		add: t.procedure
			.input(runtimeProjectAddRequestSchema)
			.output(runtimeProjectAddResponseSchema)
			.mutation(async ({ ctx, input }) => {
				await assertProjectChange(ctx, "add", { path: input.gitUrl ? null : (input.path ?? null) }, async () =>
					JSON.stringify(await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input)),
				);
				return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input);
			}),
		create: t.procedure
			.input(runtimeProjectCreateRequestSchema)
			.output(runtimeProjectCreateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				await assertProjectChange(ctx, "create", { path: input.path }, async () =>
					JSON.stringify(await ctx.projectsApi.createProject(ctx.requestedWorkspaceId, input)),
				);
				return await ctx.projectsApi.createProject(ctx.requestedWorkspaceId, input);
			}),
		roots: t.procedure.output(runtimeProjectRootsResponseSchema).query(async ({ ctx }) => {
			return await ctx.projectsApi.getProjectRoots();
		}),
		checkName: t.procedure
			.input(runtimeProjectNameCheckRequestSchema)
			.output(runtimeProjectNameCheckResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.projectsApi.checkProjectName(input);
			}),
		remove: t.procedure
			.input(runtimeProjectRemoveRequestSchema)
			.output(runtimeProjectRemoveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				await assertProjectChange(ctx, "remove", { workspaceId: input.projectId }, async () =>
					JSON.stringify(await ctx.projectsApi.removeProject(ctx.requestedWorkspaceId, input)),
				);
				return await ctx.projectsApi.removeProject(ctx.requestedWorkspaceId, input);
			}),
		// The add-project dialog's folder browsing: the user's, never a session's under isolation `enforce`.
		pickDirectory: t.procedure.output(runtimeProjectDirectoryPickerResponseSchema).mutation(async ({ ctx }) => {
			await assertMachineAction(ctx, "projects.pickDirectory");
			return await ctx.projectsApi.pickProjectDirectory(ctx.requestedWorkspaceId);
		}),
		listDirectoryContents: t.procedure
			.input(runtimeDirectoryListRequestSchema)
			.output(runtimeDirectoryListResponseSchema)
			.query(async ({ ctx, input }) => {
				await assertMachineAction(ctx, "projects.listDirectoryContents");
				return await ctx.projectsApi.listDirectoryContents(ctx.requestedWorkspaceId, input);
			}),
	}),
	hooks: t.router({
		ingest: t.procedure
			.input(runtimeHookIngestRequestSchema)
			.output(runtimeHookIngestResponseSchema)
			.mutation(async ({ ctx, input }) => {
				// Validated by ownership, not by the caller: hooks run on every tool call, and Cline runs them in its shared
				// daemon under another card's process tree. A home-agent session id names its own workspace.
				if (
					isHomeAgentSessionId(input.taskId) &&
					!isHomeAgentSessionIdForWorkspace(input.taskId, input.workspaceId)
				) {
					throw forbidden(`${input.taskId} is not a session of workspace ${input.workspaceId}.`);
				}
				return await ctx.hooksApi.ingest(input);
			}),
	}),
	// Project isolation (src/trpc/isolation-api.ts): who a caller is, the user's grants.
	isolation: t.router({
		whoami: t.procedure.output(isolationWhoamiResponseSchema).query(async ({ ctx }) => {
			if (!ctx.isolationApi) {
				return {
					caller: "user",
					workspaceId: null,
					taskId: null,
					role: null,
					via: null,
					mode: "off",
					reachable: null,
				};
			}
			return await ctx.isolationApi.whoami(await readCaller(ctx));
		}),
		grant: t.procedure
			.input(isolationGrantRequestSchema)
			.output(isolationGrantResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.isolationApi) {
					return { ok: false, grant: null, approvalId: null, error: "Project isolation is not available here." };
				}
				return await ctx.isolationApi.grant(await readStrictCaller(ctx), input);
			}),
		approve: t.procedure
			.input(isolationApproveRequestSchema)
			.output(isolationApproveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.isolationApi) {
					return { ok: false, result: null, error: "Project isolation is not available here." };
				}
				return await ctx.isolationApi.approve(await readStrictCaller(ctx), input);
			}),
		approvalStatus: t.procedure
			.input(isolationRevokeRequestSchema)
			.output(isolationApprovalStatusResponseSchema)
			.query(({ ctx, input }) =>
				ctx.isolationApi ? ctx.isolationApi.approvalStatus(input.id) : { approval: null },
			),
		requestApproval: t.procedure
			.input(isolationApprovalRequestSchema)
			.output(isolationApprovalRequestResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.isolationApi) {
					return { ok: true, approvalId: null, required: false };
				}
				return await ctx.isolationApi.requestApproval(await readStrictCaller(ctx), input);
			}),
		revoke: t.procedure
			.input(isolationRevokeRequestSchema)
			.output(isolationGrantResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.isolationApi) {
					return { ok: false, grant: null, approvalId: null, error: "Project isolation is not available here." };
				}
				return await ctx.isolationApi.revoke(await readStrictCaller(ctx), input.id);
			}),
		// A detached process of the calling session (`kanban bench calibrate`) gets a credential of its own, bound to
		// its pid: same workspace, task and role, ending when that process exits (docs/fork/project-isolation.md).
		issueChildCredential: t.procedure.output(isolationChildCredentialResponseSchema).mutation(async ({ ctx }) => {
			if (!ctx.isolationApi) {
				return { ok: false, credential: null, error: "Project isolation is not available here." };
			}
			return await ctx.isolationApi.issueChildCredential(ctx.callerRequest ?? null);
		}),
		bindChildCredential: t.procedure
			.input(isolationBindChildCredentialRequestSchema)
			.output(isolationChildCredentialResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.isolationApi) {
					return { ok: false, credential: null, error: "Project isolation is not available here." };
				}
				return await ctx.isolationApi.bindChildCredential(ctx.callerRequest ?? null, input);
			}),
		grants: t.procedure.output(isolationGrantsResponseSchema).query(async ({ ctx }) => {
			return ctx.isolationApi ? await ctx.isolationApi.listGrants(await readCaller(ctx)) : { grants: [] };
		}),
	}),
	// Plan cards (src/trpc/plans-api.ts): what a plan's approval covers, and the user's approval itself.
	plans: t.router({
		preview: workspaceProcedure
			.input(planPreviewRequestSchema)
			.output(planPreviewResponseSchema)
			.query(async ({ ctx, input }) => {
				if (!ctx.plansApi) {
					return { ok: false, plan: null, error: "Plan approval is not available here." };
				}
				return await ctx.plansApi.preview(ctx.workspaceScope.workspacePath, input);
			}),
		approve: workspaceProcedure
			.input(planApproveRequestSchema)
			.output(planApproveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.plansApi) {
					return {
						ok: false,
						approval: null,
						plan: null,
						error: "Plan approval is not available here.",
					};
				}
				// The user's in every isolation mode: a session without its credential is traced to its process tree.
				return await ctx.plansApi.approve({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					repoPath: ctx.workspaceScope.workspacePath,
					request: input,
				});
			}),
	}),
	// A project's settings on its kit (role models, project facts): the user's and that project's orchestrator's.
	kit: t.router({
		set: workspaceProcedure
			.input(kitSettingSetRequestSchema)
			.output(kitSettingChangeResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.kitSettingsApi) {
					return {
						ok: false,
						kitName: null,
						changes: [],
						historyPath: null,
						error: "Kit settings are not available here.",
					};
				}
				// In every isolation mode: a session without its credential is traced to its process tree.
				return await ctx.kitSettingsApi.set({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					request: input,
				});
			}),
		unset: workspaceProcedure
			.input(kitSettingUnsetRequestSchema)
			.output(kitSettingChangeResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.kitSettingsApi) {
					return {
						ok: false,
						kitName: null,
						changes: [],
						historyPath: null,
						error: "Kit settings are not available here.",
					};
				}
				return await ctx.kitSettingsApi.unset({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					request: input,
				});
			}),
	}),
	// A Review dev card snapshotted again and sent to the QA gate (src/trpc/pipeline-resubmit-api.ts): the user's and
	// that project's orchestrator's.
	pipeline: t.router({
		resubmit: workspaceProcedure
			.input(taskResubmitRequestSchema)
			.output(taskResubmitResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.pipelineResubmitApi) {
					return { ok: false, taskId: input.taskId, requestedAt: null, error: "Resubmit is not available here." };
				}
				// In every isolation mode: a session without its credential is traced to its process tree.
				return await ctx.pipelineResubmitApi.resubmit({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					request: input,
				});
			}),
	}),
	// A project's shortcuts (src/trpc/shortcuts-api.ts): changed by the user and that project's orchestrator; a run's
	// port ({port} / {url}) for the user's click.
	shortcuts: t.router({
		list: workspaceProcedure.output(shortcutListResponseSchema).query(async ({ ctx }) => {
			if (!ctx.shortcutsApi) {
				return { shortcuts: [] };
			}
			return await ctx.shortcutsApi.list(ctx.workspaceScope.workspacePath);
		}),
		add: workspaceProcedure
			.input(shortcutAddRequestSchema)
			.output(shortcutChangeResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.shortcutsApi) {
					return { ok: false, shortcuts: [], change: null, error: "Shortcuts are not available here." };
				}
				// In every isolation mode: a session without its credential is traced to its process tree.
				return await ctx.shortcutsApi.add({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					repoPath: ctx.workspaceScope.workspacePath,
					request: input,
				});
			}),
		remove: workspaceProcedure
			.input(shortcutRemoveRequestSchema)
			.output(shortcutChangeResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.shortcutsApi) {
					return { ok: false, shortcuts: [], change: null, error: "Shortcuts are not available here." };
				}
				return await ctx.shortcutsApi.remove({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					repoPath: ctx.workspaceScope.workspacePath,
					request: input,
				});
			}),
		prepareRun: workspaceProcedure
			.input(shortcutPrepareRunRequestSchema)
			.output(shortcutPrepareRunResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.shortcutsApi) {
					return { ok: false, command: null, port: null, url: null, error: "Shortcuts are not available here." };
				}
				return await ctx.shortcutsApi.prepareRun({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					repoPath: ctx.workspaceScope.workspacePath,
					request: input,
				});
			}),
	}),
	// GitHub issues and comments as the machine's Kanban GitHub App, and the user's creation of the app.
	github: t.router({
		issue: workspaceProcedure
			.input(githubIssueRequestSchema)
			.output(githubIssueResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.githubApi) {
					return {
						ok: false,
						via: null,
						number: null,
						url: null,
						commentUrl: null,
						postedAs: null,
						warning: null,
						error: "GitHub posts are not available here.",
					};
				}
				// In every isolation mode: the caller decides the project the post names, so a session without its
				// credential is traced to its process tree.
				return await ctx.githubApi.issue({
					caller: await readStrictCaller(ctx),
					workspaceId: ctx.workspaceScope.workspaceId,
					workspacePath: ctx.workspaceScope.workspacePath,
					request: input,
				});
			}),
		startAppCreation: t.procedure
			.input(githubAppStartRequestSchema)
			.output(githubAppStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.githubApi) {
					return {
						ok: false,
						startUrl: null,
						expiresAt: null,
						existing: null,
						error: "GitHub App creation is not available here.",
					};
				}
				return await ctx.githubApi.startAppCreation({ caller: await readStrictCaller(ctx), request: input });
			}),
		appStatus: t.procedure.output(githubAppStatusResponseSchema).query(async ({ ctx }) => {
			if (!ctx.githubApi) {
				return { ok: false, app: null, error: "GitHub App status is not available here." };
			}
			return await ctx.githubApi.appStatus({ caller: await readCaller(ctx) });
		}),
	}),
	// Orchestrator messages between projects (src/isolation/messages.ts).
	message: t.router({
		send: t.procedure
			.input(messageSendRequestSchema)
			.output(messageSendResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.isolationApi) {
					return { ok: false, message: null, queued: false, error: "Messages are not available here." };
				}
				return await ctx.isolationApi.sendMessage(await readCaller(ctx), input);
			}),
		inbox: t.procedure
			.input(messageInboxRequestSchema)
			.output(messageInboxResponseSchema)
			.query(async ({ ctx, input }) => {
				if (!ctx.isolationApi) {
					return { ok: false, workspaceId: null, messages: [], error: "Messages are not available here." };
				}
				return await ctx.isolationApi.inbox(await readCaller(ctx), input);
			}),
	}),
});

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
