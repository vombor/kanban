import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { createClineLemonadeContextSyncSettingsLoader } from "../config/cline-lemonade-context-sync-config";
import { createClineTurnDetectorSettingsLoader } from "../config/cline-turn-detector-config";
import { createLemonadeModelListSettingsLoader } from "../config/model-lists-config";
import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { createProcessReaperSettingsLoader } from "../config/process-reaper-config";
import { createCoordinationApi } from "../coordination/coordination-api";
import type {
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getDetailTerminalTaskId } from "../core/detail-terminal-session";
import { mergeAgentDefaultModels } from "../core/effective-agent";
import { isHomeAgentSessionId, isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import { providerStartFingerprint } from "../core/provider-start-intent";
import {
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimeTls,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";
import { createEfficiencyApi } from "../efficiency/efficiency-api";
import { createEfficiencyTimingStore } from "../efficiency/timing-store";
import { writeGitHubAppCredentials } from "../github-app/app-credentials";
import { createGitHubAppCreationFlow } from "../github-app/app-manifest";
import { getSharedGitHubAppTokenSource } from "../github-app/installation-tokens";
import { IntegrationChecksUnavailableError } from "../integration/checks-admission";
import { createIntegrationApi } from "../integration/integration-api";
import { createIsolationService, type IsolationService } from "../isolation/isolation-service";
import { createMessageNoticeQueue } from "../isolation/message-notices";
import { applyIssueSync } from "../issues/issue-apply";
import { loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { createKnowledgeDiscoveryApi } from "../knowledge/discovery-api";
import { createDiscoveryBroker } from "../knowledge/discovery-broker";
import { createKnowledgeApi } from "../knowledge/knowledge-api";
import { createObsidianConnectorApi } from "../knowledge/obsidian/connector-api";
import { createPlanBundleStore } from "../knowledge/plan-bundle-store";
import { createTaskContextApi } from "../knowledge/task-context-api";
import { buildTaskContextBootstrap } from "../knowledge/task-context-bootstrap";
import { createTaskContextStore } from "../knowledge/task-context-store";
import { createAgentOptionsLoader } from "../models/agent-options";
import { readAgentDefaultModels } from "../models/cline-providers";
import { createObjectiveApi } from "../objectives/objective-api";
import { createObjectiveEvidenceOwner } from "../objectives/objective-receipts";
import { createObjectiveStore } from "../objectives/objective-store";
import type { PipelineActionRequest, PipelineActionResult } from "../pipeline/actions";
import { type ChecksRequest, type ChecksResult, resolveChecksEnabled } from "../pipeline/checks";
import type { PipelineEventMap } from "../pipeline/events";
import { preserveTaskWork } from "../pipeline/hold";
import { createPipelineStateStore } from "../pipeline/pipeline-state";
import type { WatchdogActionRequest } from "../pipeline/watchdog/actions";
import { createPlanIndexStore } from "../plans/plan-index";
import { createProjectSecretsApi } from "../secrets/project-secrets-api";
import {
	checkRateLimit,
	clearRateLimit,
	extractBearerToken,
	extractSessionTokenFromCookie,
	isPasscodeEnabled,
	issueSession,
	recordFailedAttempt,
	validateInternalToken,
	validatePasscode,
	validateSession,
} from "../security/passcode-manager";
import { getTaskWorktreeSearchRootPaths } from "../state/kanban-home";
import { appendTaskHistory } from "../state/task-history-log";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContextById,
	loadWorkspaceStateById,
	mutateWorkspaceState,
} from "../state/workspace-state";
import { agentReadsClineModelsFile } from "../terminal/agent-session-adapters";
import { createAgentTokenUsageReader } from "../terminal/agent-token-usage";
import { KANBAN_CLINE_HUB_ABORT_REASONS } from "../terminal/cline-hub-abort-reason";
import type { ClineHubRunCanceller } from "../terminal/cline-hub-runs";
import { createClineTurnMonitor } from "../terminal/cline-turn-monitor";
import { deliverTaskInput } from "../terminal/deliver-task-input";
import { getAgentClearCommand } from "../terminal/orchestrator-agents";
import { DEFAULT_REVIEW_SETTLE_MS } from "../terminal/review-settle";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createGitHubApi } from "../trpc/github-api";
import { createHooksApi } from "../trpc/hooks-api";
import { createIsolationApi } from "../trpc/isolation-api";
import { createKitSettingsApi } from "../trpc/kit-settings-api";
import { createOrchestratorInboxApi } from "../trpc/orchestrator-inbox-api";
import { createPipelinePauseApi } from "../trpc/pipeline-pause-api";
import { createPipelineResubmitApi } from "../trpc/pipeline-resubmit-api";
import { createPlansApi } from "../trpc/plans-api";
import { createProjectNameApi } from "../trpc/project-name-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createProviderCapacityApi } from "../trpc/provider-capacity-api";
import { createProviderSetupApi } from "../trpc/provider-setup-api";
import { createRestartUpdateApi } from "../trpc/restart-update-api";
import { createRuntimeApi } from "../trpc/runtime-api";
import { createShortcutsApi } from "../trpc/shortcuts-api";
import { createWorkspaceApi } from "../trpc/workspace-api";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspacePathInfo,
	getTaskWorktreeCandidatePaths,
} from "../workspace/task-worktree";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { chooseBrowserOrigin, createBrowserOriginTracker, createBrowserUpgradeRecorder } from "./browser-origins";
import { createClineLemonadeContextSyncMonitor } from "./cline-lemonade-context-sync-monitor";
import { createEfficiencyObserver, efficiencySample } from "./efficiency-observer";
import { createGitHubAppRequestHandler } from "./github-app-route";
import { prepareKitDevPrompt } from "./kit-dev-instructions";
import { createModelListsRequestHandler } from "./model-lists-route";
import { accountObjectiveInput } from "./objective-input-accounting";
import { createObjectiveReconciler } from "./objective-reconciler";
import { accountObjectiveSessionStart } from "./objective-session-admission";
import { createObjectiveUsageCollector } from "./objective-usage-collector";
import { createOrchestratorInbox } from "./orchestrator-inbox";
import { createOrphanProcessSweeper } from "./orphan-process-sweeper";
import { createPipelineActionRunner } from "./pipeline-actions";
import { createPipelineControlApi } from "./pipeline-control";
import { createProcessReaper, type PreparedWorktreeReap } from "./process-reaper";
import { createProcProcessTableReader, isProcessTableSupported } from "./process-table";
import { createProviderDispatchRuntime } from "./provider-dispatch-runtime";
import { buildCallerRequest, createRequestCallerResolver } from "./request-caller";
import type { RuntimeStateHub } from "./runtime-state-hub";
import { createShortcutPortProxyHandler, createShortcutPortRegistry, isShortcutPortProxyPath } from "./shortcut-ports";
import { canAdoptTaskReferences } from "./task-context-adoption-eligibility";
import { startWithTaskContext } from "./task-context-session-admission";
import { createTaskLandingGate } from "./task-landing-gate";
import { createTaskTokenUsageLoader } from "./task-token-usage";
import { createTaskTokenUsageMonitor, isTaskTokenUsageSession } from "./task-token-usage-monitor";
import { createTaskTrashWorkflow, createTrashTaskRequestHandler, type TaskTrashWorkflow } from "./task-trash-workflow";
import { createTypedInputHold, type TypedInputHold } from "./typed-input-hold";
import { unstartedTaskEligibility } from "./unstarted-task-eligibility";
import { createWatchdogActionHandler } from "./watchdog-actions";
import type { WorkspaceRegistry } from "./workspace-registry";

interface DisposeTrackedWorkspaceResult {
	terminalManager: TerminalSessionManager | null;
	workspacePath: string | null;
}

export interface CreateRuntimeServerDependencies {
	workspaceRegistry: WorkspaceRegistry;
	runtimeStateHub: RuntimeStateHub;
	warn: (message: string) => void;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeWorkspace: (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedWorkspaceResult;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeWorkspaceStateResponse["board"]) => Set<string>;
	pickDirectoryPathFromSystemDialog: () => string | null;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
	/** The `sessionSync` setting read at startup; reported to the browser in the runtime config. */
	sessionSyncEnabled: boolean;
	/**
	 * Ends a card's runs in Cline's shared hub (src/terminal/cline-hub-runs.ts); Done, task delete and project removal
	 * call it before the card's processes are reaped (issue #28).
	 */
	cancelClineHubRuns?: ClineHubRunCanceller["cancelRuns"];
	/** Kanban landed a card (the `qa` landing step); the pipeline worker host passes it to the worker. */
	onTaskLanded?: (event: PipelineEventMap["landed"]) => void;
	/** Project isolation's state (src/isolation/isolation-service.ts); the server makes one when absent. */
	isolation?: IsolationService;
	/** `sessionSync.reviewSettleSec` in ms: orchestrator message notices wait for a settled Review. */
	reviewSettleMs?: number;
	/** Asks the pipeline worker host for a workspace's snapshot now (`kanban task resubmit`, `kanban pipeline resume`). */
	requestPipelineSnapshot?: (workspaceId: string) => void;
	runIntegrationChecks?: (request: ChecksRequest) => Promise<ChecksResult>;
	/**
	 * Shuts the server down gracefully and exits with the code (`kanban restart update`); without it the route refuses.
	 */
	requestExit?: (exitCode: number) => void;
}

export interface RuntimeServer {
	/** The server-side Done workflow; the auto-review reconciler completes cards through it. */
	taskTrashWorkflow: TaskTrashWorkflow;
	/** Carries out the pipeline worker's watchdog actions (src/server/watchdog-actions.ts). */
	handleWatchdogRequest: (request: WatchdogActionRequest) => Promise<unknown>;
	/** Runs the pipeline worker's action requests (pipeline-actions.ts). */
	runPipelineAction: (request: PipelineActionRequest) => Promise<PipelineActionResult>;
	/** Kanban's typed input held while the user types in a terminal; the pipeline snapshot reads describe(). */
	typedInputHold: Pick<TypedInputHold, "describe">;
	/** Project isolation's state: credentials, grants, the caller checks. */
	isolation: IsolationService;
	url: string;
	close: () => Promise<void>;
}

function readWorkspaceIdFromRequest(request: IncomingMessage, requestUrl: URL): string | null {
	const headerValue = request.headers["x-kanban-workspace-id"];
	const headerWorkspaceId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerWorkspaceId === "string") {
		const normalized = headerWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryWorkspaceId = requestUrl.searchParams.get("workspaceId");
	if (typeof queryWorkspaceId === "string") {
		const normalized = queryWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

export async function createRuntimeServer(deps: CreateRuntimeServerDependencies): Promise<RuntimeServer> {
	const webUiDir = getWebUiDir();

	try {
		await readFile(join(webUiDir, "index.html"));
	} catch {
		throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
	}

	const resolveWorkspaceScopeFromRequest = async (
		request: IncomingMessage,
		requestUrl: URL,
		fallbackWorkspaceId: string | null = null,
	): Promise<{
		requestedWorkspaceId: string | null;
		workspaceScope: RuntimeTrpcWorkspaceScope | null;
	}> => {
		const requestedWorkspaceId = readWorkspaceIdFromRequest(request, requestUrl) ?? fallbackWorkspaceId;
		if (!requestedWorkspaceId) {
			return {
				requestedWorkspaceId: null,
				workspaceScope: null,
			};
		}
		const requestedWorkspaceContext = await loadWorkspaceContextById(requestedWorkspaceId);
		if (!requestedWorkspaceContext) {
			return {
				requestedWorkspaceId,
				workspaceScope: null,
			};
		}
		return {
			requestedWorkspaceId,
			workspaceScope: {
				workspaceId: requestedWorkspaceContext.workspaceId,
				workspacePath: requestedWorkspaceContext.repoPath,
			},
		};
	};

	const getScopedTerminalManager = async (scope: RuntimeTrpcWorkspaceScope): Promise<TerminalSessionManager> =>
		await deps.ensureTerminalManagerForWorkspace(scope.workspaceId, scope.workspacePath);
	const prepareForStateReset = async (): Promise<void> => {
		const workspaceIds = new Set<string>();
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspaceIds.add(workspaceId);
		}
		const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
		if (activeWorkspaceId) {
			workspaceIds.add(activeWorkspaceId);
		}
		for (const workspaceId of workspaceIds) {
			deps.disposeWorkspace(workspaceId, {
				stopTerminalSessions: true,
			});
		}
		deps.workspaceRegistry.clearActiveWorkspace();
	};

	const processTableReader = isProcessTableSupported() ? createProcProcessTableReader() : null;
	const isolation =
		deps.isolation ??
		createIsolationService({
			processReader: processTableReader,
			listLiveSessions: () =>
				deps.workspaceRegistry.listManagedWorkspaces().flatMap((workspace) =>
					workspace.terminalManager.listSummaries().map((summary) => ({
						workspaceId: workspace.workspaceId,
						taskId: summary.taskId,
						agentId: summary.agentId,
						pid: summary.pid,
						cwd: summary.workspacePath ?? null,
						live: workspace.terminalManager.hasLiveProcess(summary.taskId),
					})),
				),
			warn: deps.warn,
		});
	const { resolveRequestScope, resolveRequestCaller, authorizeWorkspaceUpgrade } =
		createRequestCallerResolver(isolation);
	// Where the user's browser reaches this server (browser-origins.ts): only a browser's upgrade by the user counts.
	const browserOrigins = createBrowserOriginTracker();
	const recordBrowserUpgrade = createBrowserUpgradeRecorder({
		tracker: browserOrigins,
		resolveStrictCaller: async (request) => await resolveRequestCaller(request, true),
	});
	const processReaper = createProcessReaper({
		reader: processTableReader,
		getWorktreeRoots: getTaskWorktreeSearchRootPaths,
		log: deps.warn,
	});
	const orphanProcessSweeper = createOrphanProcessSweeper({
		reaper: processReaper,
		getWorktreeRoots: getTaskWorktreeSearchRootPaths,
		listWorkspaceBoards: async () =>
			await Promise.all(
				(await listWorkspaceIndexEntries()).map(async (entry) => ({
					workspaceId: entry.workspaceId,
					repoPath: entry.repoPath,
					board: await loadWorkspaceBoardById(entry.workspaceId).catch(() => null),
				})),
			),
		loadSettings: createProcessReaperSettingsLoader(deps.warn),
		log: deps.warn,
	});
	// Keeps Cline's Lemonade context windows equal to Lemonade's ctx_size: every sweep and right before a Cline launch.
	const clineLemonadeContextSync = createClineLemonadeContextSyncMonitor({
		loadSettings: createClineLemonadeContextSyncSettingsLoader(deps.warn),
		loadLemonadeModelList: createLemonadeModelListSettingsLoader(deps.warn),
		log: deps.warn,
	});
	// The board cards' token counts: one loader per server, so its session-file cache outlives a request (the
	// workspace API is built per request), shared by workspace.getTaskTokenUsage and the live push.
	const agentUsageReader = createAgentTokenUsageReader();
	const objectiveServerStartedAt = Date.now();
	const objectiveAdmissionAvailable = typeof deps.workspaceRegistry.setTaskAdmission === "function";
	const objectiveStore = createObjectiveStore({ admissionScopeAvailable: objectiveAdmissionAvailable });
	const loadTaskTokenUsage = createTaskTokenUsageLoader({ reader: agentUsageReader });
	const taskTokenUsageMonitor = createTaskTokenUsageMonitor({
		loadUsage: async (workspaceId) => {
			const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			if (!workspacePath) {
				return null;
			}
			const terminalManager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
			return (await loadTaskTokenUsage({ workspaceId, workspacePath }, terminalManager.listSummaries())).usage;
		},
		hasClients: deps.runtimeStateHub.hasWorkspaceClients,
		listRunningWorkspaces: () =>
			deps.workspaceRegistry
				.listManagedWorkspaces()
				.filter(
					(workspace) =>
						deps.runtimeStateHub.hasWorkspaceClients(workspace.workspaceId) &&
						workspace.terminalManager
							.listSummaries()
							.some((summary) => summary.state === "running" && isTaskTokenUsageSession(summary.taskId)),
				)
				.map((workspace) => workspace.workspaceId),
		broadcast: deps.runtimeStateHub.broadcastTaskTokenUsageUpdated,
		warn: deps.warn,
	});
	const unsubscribeTaskTokenUsageActivity = deps.runtimeStateHub.onWorkspaceActivity((activity) => {
		if (activity.summary) {
			taskTokenUsageMonitor.noteActivity(activity.workspaceId, activity.summary.taskId);
		}
	});
	// Ends Cline CLI turns that Cline's TaskComplete hook missed, through the same ingest path the hook uses.
	const inProcessHooksApi = createHooksApi({
		getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
		ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
		broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
		broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
	});
	const clineTurnMonitor = createClineTurnMonitor({
		listWorkspaces: () =>
			deps.workspaceRegistry.listManagedWorkspaces().map((workspace) => ({
				workspaceId: workspace.workspaceId,
				sessions: workspace.terminalManager,
			})),
		loadSettings: createClineTurnDetectorSettingsLoader(deps.warn),
		endTurn: async ({ workspaceId, taskId }) =>
			await inProcessHooksApi.ingest({
				taskId,
				workspaceId,
				event: "to_review",
				metadata: {
					source: "cline-turn-detector",
					hookEventName: "TaskComplete",
					activityText: "Waiting for review",
				},
			}),
		log: deps.warn,
	});
	/**
	 * Task delete, project removal and Done reap a card's processes before its worktree is deleted. First its runs in
	 * Cline's shared hub end: the reaper never signals the hub, and a run there outlives the card's TUI (issue #28).
	 */
	const prepareTaskProcessReap = async (
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<PreparedWorktreeReap> => {
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(scope.workspaceId);
		const sessionPids = [taskId, getDetailTerminalTaskId(taskId)]
			.map((sessionId) => terminalManager?.getSummary(sessionId)?.pid)
			.filter((pid): pid is number => typeof pid === "number" && pid > 0);
		const worktreePaths = getTaskWorktreeCandidatePaths(scope.workspacePath, taskId);
		const prepared = await processReaper.prepareWorktreeReap({ taskId, worktreePaths, sessionPids });
		const cancelHubRuns = async () =>
			await deps
				.cancelClineHubRuns?.({
					workspaceId: scope.workspaceId,
					taskId,
					worktreePaths,
					reason: KANBAN_CLINE_HUB_ABORT_REASONS.doneOrDeleted,
				})
				.catch((error: unknown) => {
					deps.warn(
						`Could not end the Cline hub runs of task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
		return {
			reap: async () => {
				await cancelHubRuns();
				return await prepared.reap().catch((error: unknown) => {
					deps.warn(
						`Could not reap processes of task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return [];
				});
			},
		};
	};

	// Kanban's own typed input (sidebar wakes, the pipeline's card input) waits while the user types in that terminal,
	// and `kanban task send` is refused meanwhile (typed-input-hold.ts, issue #35).
	const typedInputHold = createTypedInputHold({
		getTerminal: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId) ?? null,
		deliver: async (terminal, taskId, text, options) => {
			const summary = terminal.getSummary(taskId);
			const ownerWorkspace = deps.workspaceRegistry
				.listManagedWorkspaces()
				.find((workspace) => workspace.terminalManager === terminal);
			if (ownerWorkspace) {
				const gate = await objectiveStore
					.check(ownerWorkspace.workspaceId, taskId, "input")
					.catch(() => ({ bound: true, allowed: false, reason: "enforcement_unavailable" }));
				if (gate && !gate.allowed)
					return {
						ok: false,
						status: "busy",
						evidence: null,
						enterAttempts: 0,
						summary,
						error: `Objective admission held (${gate.reason}); nothing was typed.`,
					};
			}
			const modelInput =
				summary &&
				(options?.enter ?? true) &&
				(!summary.agentId || text.trim() !== getAgentClearCommand(summary.agentId));
			const delivered = async () => await deliverTaskInput(terminal, taskId, text, options);
			const accountDelivery = async () =>
				modelInput && ownerWorkspace
					? await accountObjectiveInput({
							accounting: objectiveStore,
							workspaceId: ownerWorkspace.workspaceId,
							taskId,
							deliver: delivered,
						})
					: await delivered();
			if (
				!summary ||
				(summary.state === "running" &&
					(summary.dispatchPromptSubmitted !== false || (summary.lastHookAt ?? 0) > (summary.startedAt ?? 0))) ||
				options?.enter === false ||
				terminal.hasTypedInputSinceEnter(taskId)
			)
				return terminal.hasTypedInputSinceEnter(taskId) ? await delivered() : await accountDelivery();
			const workspace = deps.workspaceRegistry
				.listManagedWorkspaces()
				.find((workspace) => workspace.terminalManager === terminal);
			if (!workspace) return await deliverTaskInput(terminal, taskId, text, options);
			const board = await loadWorkspaceBoardById(workspace.workspaceId);
			const card = board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
			const decision = await providerDispatcher.admission({
				workspaceId: workspace.workspaceId,
				taskId,
				body: {
					taskId,
					prompt: text,
					baseRef: card?.baseRef ?? "HEAD",
					agentId: summary.agentId ?? undefined,
					agentSettings: summary.providerId ? { providerId: summary.providerId } : card?.agentSettings,
				},
				fingerprint: card ? providerStartFingerprint(card) : "sidebar",
				at: Date.now(),
				explicit: true,
			});
			if (!(await providerDispatcher.reserveInput(workspace.workspaceId, taskId, decision)))
				return {
					ok: false,
					status: "busy",
					evidence: null,
					enterAttempts: 0,
					summary,
					error: "Shared provider capacity/quota is held; nothing was typed.",
				};
			let typed = false;
			try {
				const result = await accountDelivery();
				typed = !["busy", "user_typing", "no_session", "error", "aborted"].includes(result.status);
				if (typed && (options?.enter ?? true))
					workspace.terminalManager.recordDispatchProvider(taskId, decision.provider, true);
				return result;
			} finally {
				if (!typed) providerDispatcher.releaseInput(workspace.workspaceId, taskId);
				else {
					const release = setTimeout(() => providerDispatcher.releaseInput(workspace.workspaceId, taskId), 12_000);
					release.unref();
				}
			}
		},
		log: deps.warn,
	});
	typedInputHold.start();
	// Silent watchdog wakes for the orchestrator sidebar: taken by its prompt hook, typed once due (orchestrator-inbox.ts).
	const orchestratorInbox = createOrchestratorInbox({
		getTerminal: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId) ?? null,
		hold: typedInputHold,
		listWorkspaceIds: () => deps.workspaceRegistry.listManagedWorkspaces().map((workspace) => workspace.workspaceId),
		log: deps.warn,
	});
	orchestratorInbox.start();
	const launchAuthorization = new WeakMap<object, AbortSignal>();
	const launchReceiptIds = new WeakMap<object, string>();
	let runtimeApi: RuntimeTrpcContext["runtimeApi"];
	const providerDispatcher = createProviderDispatchRuntime({
		registry: deps.workspaceRegistry,
		objectiveHold: async (workspaceId, taskId) => {
			try {
				return !(await objectiveStore.check(workspaceId, taskId, "start")).allowed;
			} catch {
				return true;
			} // Unreadable own state holds this project, not every other project's provider queue.
		},
		launch: async (intent, signal) => {
			const repo = deps.workspaceRegistry.getWorkspacePathById(intent.workspaceId);
			if (!repo)
				return { ok: false, summary: null, error: "Queued project is unavailable; no session was launched." };
			const input = { ...intent.body };
			launchAuthorization.set(input, signal);
			if (intent.id) launchReceiptIds.set(input, intent.id);
			const start = async () =>
				await runtimeApi.startTaskSession({ workspaceId: intent.workspaceId, workspacePath: repo }, input);
			const result = await start();
			if (signal.aborted && result.summary)
				await runtimeApi.stopTaskSession(
					{ workspaceId: intent.workspaceId, workspacePath: repo },
					{ taskId: intent.taskId },
				);
			return result;
		},
		broadcast: async (workspaceId) => {
			const path = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			if (path) await deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(workspaceId, path);
		},
		log: deps.warn,
	});
	const taskContexts = createTaskContextStore();
	const validateKnowledgeAnchor = async (workspaceId: string, taskId: string) => {
		const card = (await loadWorkspaceBoardById(workspaceId)).columns
			.flatMap((column) => column.cards)
			.find((card) => card.id === taskId);
		const view = await taskContexts.inspect(workspaceId, taskId);
		if (card?.knowledgeHandoff && view.history[0]?.revision !== card.knowledgeHandoff.rootRevision)
			throw new Error(
				"Retained knowledge attachment is missing or mismatched; no unpinned task action is permitted.",
			);
		return card?.knowledgeHandoff?.rootRevision;
	};
	runtimeApi = createRuntimeApi({
		taskContextBootstrap: async (workspaceId, taskId) => {
			await validateKnowledgeAnchor(workspaceId, taskId);
			return buildTaskContextBootstrap(taskContexts, workspaceId, taskId);
		},
		objectiveAdmission: objectiveStore,
		launchReceiptIds,
		providerDispatcher,
		launchAuthorization,
		getAgentSettingsOptions: createAgentOptionsLoader(),
		typedInputHold,
		getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
		getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
		loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
		setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
		getScopedTerminalManager,
		resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
		prepareForStateReset,
		getUpdateStatus: deps.getUpdateStatus,
		runUpdateNow: deps.runUpdateNow,
		getProcessSweep: orphanProcessSweeper.getStatus,
		runProcessSweep: async () => {
			await orphanProcessSweeper.sweep();
			return await orphanProcessSweeper.getStatus();
		},
		sessionSyncEnabled: deps.sessionSyncEnabled,
		isolation,
		beforeAgentLaunch: async (agentId) => {
			if (agentReadsClineModelsFile(agentId)) {
				await clineLemonadeContextSync.sync("launch");
			}
		},
	});
	// Orchestrator message notices wait for the receiver's settled Review with nothing typed (message-notices.ts).
	const messageNotices = createMessageNoticeQueue({
		findOrchestratorSession: (workspaceId) => {
			const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
			const summary = terminalManager
				?.listSummaries()
				.find(
					(candidate) =>
						isHomeAgentSessionIdForWorkspace(candidate.taskId, workspaceId) &&
						terminalManager.hasLiveProcess(candidate.taskId),
				);
			if (!terminalManager || !summary) {
				return null;
			}
			return { taskId: summary.taskId, summary, hasDraft: terminalManager.hasTypedInputSinceEnter(summary.taskId) };
		},
		deliver: async (workspaceId, taskId, notice) => {
			const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
			return terminalManager
				? (await typedInputHold.deliverUnlessBusy(terminalManager, workspaceId, taskId, notice)).ok
				: false;
		},
		settleMs: deps.reviewSettleMs ?? DEFAULT_REVIEW_SETTLE_MS,
	});
	messageNotices.start();
	// A session's credential stops working when its process ends (resolveCaller checks that too); this drops them.
	const credentialSweep = setInterval(() => void isolation.pruneCredentials().catch(() => undefined), 10_000);
	credentialSweep.unref();
	deps.workspaceRegistry.setTaskAdmission?.(
		async (workspaceId, request, start) =>
			await accountObjectiveSessionStart({
				accounting: objectiveStore,
				workspaceId,
				taskId: request.taskId,
				requestId: request.admissionId,
				start: async () =>
					startWithTaskContext({
						contexts: taskContexts,
						workspaceId,
						request,
						start: async (prepared) => {
							const launch = prepared ?? request;
							return start({
								...launch,
								prompt: await prepareKitDevPrompt(workspaceId, launch.taskId, launch.prompt),
							});
						},
						rootRevision: await validateKnowledgeAnchor(workspaceId, request.taskId),
					}),
			}),
		async (workspaceId, request) => {
			const repo = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			if (!repo) throw new Error("Automatic restart has no registered project; nothing was started.");
			const board = await loadWorkspaceBoardById(workspaceId),
				column = board.columns.find((column) => column.cards.some((card) => card.id === request.taskId));
			if (column?.id === "trash")
				throw new Error("Automatic restart card is Done; no worktree or session was restarted.");
			const card = column?.cards.find((card) => card.id === request.taskId);
			if (!card && !isHomeAgentSessionId(request.taskId))
				throw new Error("Automatic restart card is absent; nothing was started.");
			const result = await runtimeApi.startTaskSession(
				{ workspaceId, workspacePath: repo },
				{
					taskId: request.taskId,
					prompt: card?.prompt ?? request.prompt,
					baseRef: card?.baseRef ?? "HEAD",
					agentId: card?.agentId ?? request.agentId,
					agentSettings: card?.agentSettings ?? request.agentSettings,
					images: card?.images,
					resumeFromTrash: request.resumeFromTrash,
				},
			);
			if (!result.ok) throw new Error(result.error ?? "Automatic restart was refused by ordinary admission.");
		},
	);
	const isolationApi = createIsolationApi({
		service: isolation,
		listEntries: listWorkspaceIndexEntries,
		notices: messageNotices,
	});
	const plansApi = createPlansApi({ log: isolation.log });
	const kitSettingsApi = createKitSettingsApi({ log: isolation.log });
	const orchestratorInboxApi = createOrchestratorInboxApi({ inbox: orchestratorInbox, log: deps.warn });
	const providerSetupApi = createProviderSetupApi({ log: isolation.log });
	const requestExit = deps.requestExit;
	const restartUpdateApi = requestExit
		? createRestartUpdateApi({
				log: isolation.log,
				warn: deps.warn,
				listWorkspaces: async () =>
					(await listWorkspaceIndexEntries()).map((entry) => ({
						workspaceId: entry.workspaceId,
						repoPath: entry.repoPath,
					})),
				loadState: async (target) =>
					await deps.workspaceRegistry.buildWorkspaceStateSnapshot(target.workspaceId, target.repoPath),
				requestExit,
			})
		: undefined;
	const pipelineResubmitApi = createPipelineResubmitApi({
		log: isolation.log,
		loadWorkspaceState: loadWorkspaceStateById,
		getLiveSession: (workspaceId, taskId) =>
			deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId)?.getSummary(taskId) ?? null,
		requestSnapshot: (workspaceId) => deps.requestPipelineSnapshot?.(workspaceId),
	});
	const providerCapacityApi = createProviderCapacityApi({
		listWorkspaceIds: () => deps.workspaceRegistry.listManagedWorkspaces().map((workspace) => workspace.workspaceId),
		loadWorkspace: async (workspaceId) => {
			const state = await loadWorkspaceStateById(workspaceId);
			if (!state) {
				return null;
			}
			const live = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId)?.listSummaries() ?? [];
			const config = await deps.workspaceRegistry.loadScopedRuntimeConfig({
				workspaceId,
				workspacePath: state.repoPath,
			});
			return {
				board: state.board,
				sessions: Object.values({
					...state.sessions,
					...Object.fromEntries(live.map((summary) => [summary.taskId, summary])),
				}),
				selectedAgentId: config.selectedAgentId,
			};
		},
		loadAgentDefaultModels: async (config) => await readAgentDefaultModels(config.config.agents.cline.dataDir),
	});
	const pipelinePauseApi = createPipelinePauseApi({
		log: isolation.log,
		requestSnapshot: (workspaceId) => deps.requestPipelineSnapshot?.(workspaceId),
		broadcastProjects: (workspaceId) => void deps.runtimeStateHub.broadcastRuntimeProjectsUpdated(workspaceId),
	});
	const projectNameApi = createProjectNameApi({
		log: isolation.log,
		broadcastProjects: (workspaceId) => void deps.runtimeStateHub.broadcastRuntimeProjectsUpdated(workspaceId),
	});
	const pipelineControlApi = createPipelineControlApi({
		isRunning: (workspaceId, taskId) => {
			const manager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
			return Boolean(manager?.hasLiveProcess(taskId) && manager.getSummary(taskId)?.state === "running");
		},
		isLive: (workspaceId, taskId) =>
			deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId)?.hasLiveProcess(taskId) ?? false,
		canReview: async (workspaceId) => {
			const { config } = await readPipelineConfig();
			const settings = getWorkspacePipelineSettings(config, workspaceId);
			return settings.landing.mode === "qa" && !settings.pipeline.shadow && !config.pipeline.paused;
		},
		wake: (workspaceId) => deps.requestPipelineSnapshot?.(workspaceId),
	});
	const projectSecretsApi = createProjectSecretsApi();
	const obsidianConnectorApi = createObsidianConnectorApi();
	const knowledgeApi = createKnowledgeApi();
	const knowledgeDiscoveryApi = createKnowledgeDiscoveryApi(
		createDiscoveryBroker({ projectPath: deps.workspaceRegistry.getWorkspacePathById }),
	);
	const efficiencyTiming = createEfficiencyTimingStore();
	const coordinationApi = createCoordinationApi({
		plans: createPlanIndexStore(),
		bundles: createPlanBundleStore(),
		capacity: providerCapacityApi,
		load: async (workspaceId) => {
			const state = await loadWorkspaceStateById(workspaceId);
			if (!state) throw new Error("Project unavailable");
			const runtime = await deps.workspaceRegistry.loadScopedRuntimeConfig({
				workspaceId,
				workspacePath: state.repoPath,
			});
			const live = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId)?.listSummaries() ?? [];
			const parsed = await readPipelineConfig();
			return {
				repoPath: state.repoPath,
				board: state.board,
				sessions: Object.values({
					...state.sessions,
					...Object.fromEntries(live.map((summary) => [summary.taskId, summary])),
				}),
				stages: deps.runtimeStateHub.getPipelineCardStages(workspaceId),
				selectedAgentId: runtime.selectedAgentId,
				config: parsed.config,
				settleMs: deps.reviewSettleMs,
				agentDefaultModels: mergeAgentDefaultModels(
					runtime.agentDefaults,
					await readAgentDefaultModels(parsed.config.agents.cline.dataDir),
				),
			};
		},
	});
	const efficiencyApi = createEfficiencyApi({
		objectives: objectiveStore,
		plans: createPlanIndexStore(),
		contexts: taskContexts,
		timing: efficiencyTiming,
		board: loadWorkspaceBoardById,
	});
	const integrationService = createIntegrationApi({
		coordination: coordinationApi,
		contexts: taskContexts,
		checks: async (request) => {
			if (!deps.runIntegrationChecks) throw new IntegrationChecksUnavailableError();
			return deps.runIntegrationChecks(request);
		},
		setup: async (workspaceId) => {
			const repoPath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			if (!repoPath) throw new Error("Project unavailable");
			const parsed = await readPipelineConfig(),
				settings = getWorkspacePipelineSettings(parsed.config, workspaceId),
				resolution = resolveWorkspaceKit(parsed.config, workspaceId, await loadKitCatalog());
			if (resolution.issues.length) throw new Error("Project checks configuration unavailable");
			return {
				repoPath,
				settings: parsed.config.pipeline.checks,
				scripts: settings.checks.scripts,
				project: resolution.kit.checks,
				checksEnabled: resolveChecksEnabled(settings, resolution.kitName),
				paused: parsed.config.pipeline.paused,
				alternateWorker: Boolean(parsed.config.pipeline.workerEntry),
			};
		},
	});
	const efficiencyObserver = createEfficiencyObserver({
		store: efficiencyTiming,
		workspaces: () => deps.workspaceRegistry.listManagedWorkspaces().map((workspace) => workspace.workspaceId),
		warn: deps.warn,
		sample: async (workspaceId) => {
			const manager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
			if (!manager) return { labels: {}, counters: {} };
			const board = await loadWorkspaceBoardById(workspaceId),
				sessions = manager.listSummaries();
			return efficiencySample({
				sessions,
				stages: deps.runtimeStateHub.getPipelineCardStages(workspaceId),
				taskIds: new Set(
					board.columns
						.filter((column) => column.id !== "trash")
						.flatMap((column) => column.cards.map((card) => card.id)),
				),
				isLive: (taskId) => manager.hasLiveProcess(taskId),
				now: Date.now(),
				settleMs: deps.reviewSettleMs ?? DEFAULT_REVIEW_SETTLE_MS,
			});
		},
	});
	const objectiveReceiptStore = createPipelineStateStore();
	const canAttachKnowledge = async (workspaceId: string, taskId: string) => {
		const state = await loadWorkspaceStateById(workspaceId);
		if (!state) return false;
		const live = Object.fromEntries(
			(deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId)?.listSummaries() ?? []).map((summary) => [
				summary.taskId,
				summary,
			]),
		);
		const eligible = await unstartedTaskEligibility({
			workspaceId,
			board: state.board,
			sessions: { ...state.sessions, ...live },
			pipelineTaskIds: Object.keys((await objectiveReceiptStore.peek(workspaceId))?.cards ?? {}),
		});
		if (eligible.known.has(taskId)) return false;
		return !(await getTaskWorkspacePathInfo({ cwd: state.repoPath, taskId, baseRef: "HEAD" })).exists;
	};
	const taskKnowledgeApi = createTaskContextApi({
		contexts: taskContexts,
		admissionAvailable: objectiveAdmissionAvailable,
		canAttachDerived: canAttachKnowledge,
		validateAnchor: async (workspaceId, taskId) => {
			await validateKnowledgeAnchor(workspaceId, taskId);
		},
		canAdopt: async (workspaceId, taskId) => {
			const state = await loadWorkspaceStateById(workspaceId);
			if (!state) return false;
			const manager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
			return canAdoptTaskReferences({
				workspaceId,
				taskId,
				state,
				repoPath: state.repoPath,
				live: Object.fromEntries((manager?.listSummaries() ?? []).map((summary) => [summary.taskId, summary])),
				pipelineTaskIds: Object.keys((await objectiveReceiptStore.peek(workspaceId))?.cards ?? {}),
			});
		},
	});
	const objectiveReconciler = createObjectiveReconciler({
		serverStartedAt: objectiveServerStartedAt,
		collectUsage: createObjectiveUsageCollector({
			store: objectiveStore,
			reader: agentUsageReader,
			workspacePath: deps.workspaceRegistry.getWorkspacePathById,
		}),
		store: objectiveStore,
		pipeline: objectiveReceiptStore,
		reviewSettleMs: deps.reviewSettleMs,
		listWorkspaces: () =>
			deps.workspaceRegistry.listManagedWorkspaces().map((workspace) => ({
				workspaceId: workspace.workspaceId,
				summaries: workspace.terminalManager.listSummaries(),
				isLive: (taskId: string) => workspace.terminalManager.hasLiveProcess(taskId),
			})),
		warn: deps.warn,
	});
	const unsubscribeObjectiveActivity = deps.runtimeStateHub.onWorkspaceActivity((activity) => {
		if (activity.summary)
			objectiveReconciler.noteActivity(
				activity.workspaceId,
				activity.summary,
				deps.workspaceRegistry
					.getTerminalManagerForWorkspace(activity.workspaceId)
					?.hasLiveProcess(activity.summary.taskId) ?? false,
			);
	});
	const objectiveApi = createObjectiveApi({
		admissionScopeAvailable: objectiveAdmissionAvailable,
		taskEligibility: async (workspaceId) => {
			const state = await loadWorkspaceStateById(workspaceId);
			if (!state) throw new Error("Objective project is unavailable.");
			const sessions = Object.fromEntries(
				(deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId)?.listSummaries() ?? []).map(
					(summary) => [summary.taskId, summary],
				),
			);
			const pipeline = await objectiveReceiptStore.peek(workspaceId);
			return unstartedTaskEligibility({
				workspaceId,
				board: state.board,
				sessions: { ...state.sessions, ...sessions },
				pipelineTaskIds: Object.keys(pipeline?.cards ?? {}),
			});
		},
		store: objectiveStore,
		recheck: async (workspaceId) => await objectiveReconciler.recheck(workspaceId),
		taskIds: async (workspaceId) =>
			new Set(
				(await loadWorkspaceBoardById(workspaceId)).columns.flatMap((column) =>
					column.cards.filter((card) => resolveCardRole(card) === "dev").map((card) => card.id),
				),
			),
	});
	// Shortcut runs that ask for a port, and the proxy the browser reaches those ports through (shortcut-ports.ts).
	const shortcutPorts = createShortcutPortRegistry();
	const handleShortcutPortProxyRequest = createShortcutPortProxyHandler({
		ports: shortcutPorts,
		tls: getKanbanRuntimeTls() !== null,
		log: deps.warn,
	});
	const shortcutsApi = createShortcutsApi({
		log: isolation.log,
		ports: shortcutPorts,
		onChanged: (workspaceId) => deps.runtimeStateHub.broadcastProjectShortcutsUpdated(workspaceId),
	});
	const githubAppTokenSource = getSharedGitHubAppTokenSource();
	const githubAppCreationFlow = createGitHubAppCreationFlow({
		writeCredentials: async (credentials) => await writeGitHubAppCredentials(credentials),
		log: deps.warn,
	});
	const githubApi = createGitHubApi({
		tokenSource: githubAppTokenSource,
		flow: githubAppCreationFlow,
		chooseOrigin: async ({ requested, callerRequest }) =>
			chooseBrowserOrigin({
				requested,
				callingTerminal:
					callerRequest && !requested ? await isolation.findCallingSession(callerRequest).catch(() => null) : null,
				tracker: browserOrigins,
			}),
		log: isolation.log,
		warn: deps.warn,
	});
	const handleGitHubAppRequest = createGitHubAppRequestHandler({
		flow: githubAppCreationFlow,
		tokenSource: githubAppTokenSource,
		webUiDir,
	});

	const handleWatchdogRequest = createWatchdogActionHandler({
		getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
		getTerminal: getScopedTerminalManager,
		startTaskSession: async (scope, input) => await runtimeApi.startTaskSession(scope, input),
		credentials: isolation,
		inputHold: typedInputHold,
		prepareTaskInput: prepareKitDevPrompt,
		orchestratorInbox,
		runProcessSweep: async () => {
			await orphanProcessSweeper.sweep();
			return await orphanProcessSweeper.getStatus();
		},
		onBoardMutated: async (scope) =>
			await deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath),
	});

	const taskTrashWorkflow = createTaskTrashWorkflow({
		mutateWorkspaceState,
		preserveWork: async (scope, taskId, tag) =>
			await preserveTaskWork({ workspacePath: scope.workspacePath, taskId, tag }),
		stopTaskSession: async (scope, taskId) => {
			const terminalManager = await getScopedTerminalManager(scope);
			terminalManager.stopTaskSession(taskId);
		},
		deleteTaskWorktree: async (scope, taskId) => await deleteTaskWorktree({ repoPath: scope.workspacePath, taskId }),
		prepareProcessReap: prepareTaskProcessReap,
		ensureTaskWorktree: async (scope, input) =>
			await ensureTaskWorktreeIfDoesntExist({
				cwd: scope.workspacePath,
				taskId: input.taskId,
				baseRef: input.baseRef,
			}),
		startTaskSession: async (scope, input) => await runtimeApi.startTaskSession(scope, input),
		onBoardMutated: async (scope) =>
			await deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath),
		// Landing mode `qa`: land before Done, or ask "land or discard?". Passes every other workspace through.
		doneGate: createTaskLandingGate({
			objectives: createObjectiveEvidenceOwner(objectiveStore),
			objectiveReceiptStore,
			stopProcessesUnder: async (directories) => {
				const prepared = await processReaper.prepareWorktreeReap({
					taskId: "post-land",
					worktreePaths: directories,
					sessionPids: [],
				});
				await prepared.reap();
			},
			onLanded: deps.onTaskLanded,
			log: deps.warn,
		}),
		recordHistory: async (entry) => await appendTaskHistory(entry),
		warn: deps.warn,
	});
	const handleTrashTaskRequest = createTrashTaskRequestHandler(taskTrashWorkflow);
	const runPipelineAction = createPipelineActionRunner({
		attachKnowledge: async (workspaceId, task) => {
			if (!task.knowledgeSource) return undefined;
			await validateKnowledgeAnchor(workspaceId, task.knowledgeSource.sourceTaskId);
			const context = await taskContexts.attachDerived(workspaceId, task.taskId, task.knowledgeSource, () =>
				canAttachKnowledge(workspaceId, task.taskId),
			);
			return context ? { rootRevision: context.revision } : undefined;
		},
		prepareKnowledgeRework: async (request) => {
			const rootRevision = await validateKnowledgeAnchor(request.workspaceId, request.taskId);
			const result = await taskContexts.reserveAttempt(
				request.workspaceId,
				{
					taskId: request.taskId,
					kind: "rework_handoff",
					requestId: JSON.stringify([request.snapshot, request.round, request.at]),
					...(request.snapshot ? { snapshot: request.snapshot } : {}),
					round: request.round,
				},
				rootRevision,
			);
			return result?.attempt.id ?? null;
		},
		canAdmitTask: async (scope, taskId) => {
			try {
				await validateKnowledgeAnchor(scope.workspaceId, taskId);
			} catch {
				return "Retained knowledge is unavailable; the existing process was not stopped.";
			}
			const decision = await objectiveStore.check(scope.workspaceId, taskId, "start");
			return decision.allowed
				? null
				: `Objective admission held (${decision.reason}); its existing process was not stopped.`;
		},
		mutateWorkspaceState,
		ensureTaskWorktree: async (scope, input) =>
			await ensureTaskWorktreeIfDoesntExist({
				cwd: scope.workspacePath,
				taskId: input.taskId,
				baseRef: input.baseRef,
			}),
		startTaskSession: async (scope, input) => await runtimeApi.startTaskSession(scope, input),
		hasLiveProcess: async (scope, taskId) => (await getScopedTerminalManager(scope)).hasLiveProcess(taskId),
		stopTaskSession: async (scope, taskId) => {
			(await getScopedTerminalManager(scope)).stopTaskSession(taskId);
		},
		onBoardMutated: async (scope) =>
			await deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath),
		applyIssues: async (input) =>
			await applyIssueSync(input, {
				mutateWorkspaceState,
				onBoardMutated: async (scope) =>
					await deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath),
			}),
	});

	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		// The caller is resolved on first use (hooks.ingest, the hot path, never asks); a session's call without a
		// workspace is scoped to its own project, never to the server's active one.
		const { getCaller, resolveStrictCaller, fallbackWorkspaceId } = await resolveRequestScope(req);
		const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl, fallbackWorkspaceId);
		const sessionToken = extractSessionTokenFromCookie(req.headers.cookie);
		return {
			requestedWorkspaceId: scope.requestedWorkspaceId,
			workspaceScope: scope.workspaceScope,
			getCaller,
			resolveStrictCaller,
			callerRequest: buildCallerRequest(req),
			// The passcode gate's browser cookie (remote mode): the user at the browser, so no console code is needed.
			trustedBrowser: isRemoteMode && isPasscodeEnabled() && sessionToken !== null && validateSession(sessionToken),
			isolationApi,
			plansApi,
			kitSettingsApi,
			orchestratorInboxApi,
			providerSetupApi,
			restartUpdateApi,
			pipelineResubmitApi,
			providerCapacityApi,
			pipelinePauseApi,
			pipelineControlApi,
			providerDispatchStatus: async (workspaceId) => {
				const pending = (await providerDispatcher.pending()).filter((intent) => intent.workspaceId === workspaceId);
				const active = await providerDispatcher.activity();
				const queued = await Promise.all(
					pending.map(async (intent) => {
						const decision = await providerDispatcher.admission(intent);
						return {
							taskId: intent.taskId,
							providerId: decision.provider,
							requestedAt: intent.at,
							until: decision.until === Number.MAX_SAFE_INTEGER ? null : decision.until,
						};
					}),
				);
				return {
					limits: await providerDispatcher.limits(),
					queued,
					holders: active
						.filter((item) => item.key.startsWith(`${workspaceId}\0`))
						.map((item) => ({ taskId: item.key.split("\0")[1] ?? "", resources: item.resources })),
					otherActive: new Set(
						active.filter((item) => !item.key.startsWith(`${workspaceId}\0`)).map((item) => item.key),
					).size,
				};
			},
			projectNameApi,
			projectSecretsApi,
			obsidianConnectorApi,
			knowledgeApi,
			knowledgeDiscoveryApi,
			coordinationApi,
			integrationApi: integrationService.api,
			efficiencyApi,
			taskKnowledgeApi,
			objectiveApi,
			getPipelineCardStages: deps.runtimeStateHub.getPipelineCardStages,
			shortcutsApi,
			githubApi,
			runtimeApi,
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
				trashTask: handleTrashTaskRequest,
				prepareTaskProcessReap,
				loadTaskTokenUsage,
			}),
			projectsApi: createProjectsApi({
				getActiveWorkspacePath: deps.workspaceRegistry.getActiveWorkspacePath,
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				rememberWorkspace: deps.workspaceRegistry.rememberWorkspace,
				setActiveWorkspace: deps.workspaceRegistry.setActiveWorkspace,
				clearActiveWorkspace: deps.workspaceRegistry.clearActiveWorkspace,
				resolveProjectInputPath: deps.resolveProjectInputPath,
				assertPathIsDirectory: deps.assertPathIsDirectory,
				hasGitRepository: deps.hasGitRepository,
				summarizeProjectTaskCounts: deps.workspaceRegistry.summarizeProjectTaskCounts,
				createProjectSummary: deps.workspaceRegistry.createProjectSummary,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				getTerminalManagerForWorkspace: deps.workspaceRegistry.getTerminalManagerForWorkspace,
				disposeWorkspace: deps.disposeWorkspace,
				collectProjectWorktreeTaskIdsForRemoval: deps.collectProjectWorktreeTaskIdsForRemoval,
				prepareTaskProcessReap,
				warn: deps.warn,
				buildProjectsPayload: deps.workspaceRegistry.buildProjectsPayload,
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
				serverCwd: process.cwd(),
			}),
			hooksApi: createHooksApi({
				getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
			}),
		};
	};

	const trpcHttpHandler = createHTTPHandler({
		basePath: "/api/trpc/",
		router: runtimeAppRouter,
		createContext: async ({ req }) => await createTrpcContext(req),
	});

	const isRemoteMode = isKanbanRemoteHost();

	const readRequestBody = (req: IncomingMessage, maxBytes = 4096): Promise<string> =>
		new Promise((resolve, reject) => {
			let body = "";
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					reject(new Error("Request body too large"));
					return;
				}
				body += chunk.toString("utf8");
			});
			req.on("end", () => resolve(body));
			req.on("error", reject);
		});

	const getRemoteIp = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

	const handleModelListsRequest = createModelListsRequestHandler({
		loadLemonadeSettings: createLemonadeModelListSettingsLoader(deps.warn),
		warn: deps.warn,
	});

	const tlsConfig = getKanbanRuntimeTls();
	const requestHandler = async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
		try {
			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);

			// Model lists are fetched by agent CLIs (Cline's modelsSourceUrl), which have no session cookie or token.
			// They hold only model ids and labels, so they are served ahead of the passcode gate.
			if (await handleModelListsRequest(req, res, pathname)) {
				return;
			}
			// The GitHub App's manifest flow: GitHub's redirect carries no session cookie; its one-time state
			// authorizes it (src/server/github-app-route.ts).
			if (await handleGitHubAppRequest(req, res, pathname)) {
				return;
			}

			// ── Passcode gate (remote mode only) ──────────────────────────────
			const passcodeActive = isRemoteMode && isPasscodeEnabled();
			if (pathname === "/api/passcode/status") {
				if (passcodeActive) {
					const token = extractSessionTokenFromCookie(req.headers.cookie);
					const authenticated = token !== null && validateSession(token);
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: true, authenticated }));
				} else {
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: false, authenticated: true }));
				}
				return;
			}
			if (passcodeActive && req.method === "POST" && pathname === "/api/passcode/verify") {
				const ip = getRemoteIp(req);
				const rateLimit = checkRateLimit(ip);
				if (!rateLimit.allowed) {
					const retryAfterSec = rateLimit.lockedUntilMs
						? Math.ceil((rateLimit.lockedUntilMs - Date.now()) / 1000)
						: 30;
					res.writeHead(429, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
						"Retry-After": String(retryAfterSec),
					});
					res.end(JSON.stringify({ error: "Too many attempts. Please wait before trying again." }));
					return;
				}
				let body: string;
				try {
					body = await readRequestBody(req);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid request body." }));
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid JSON." }));
					return;
				}
				const submitted =
					parsed !== null &&
					typeof parsed === "object" &&
					"passcode" in parsed &&
					typeof (parsed as Record<string, unknown>).passcode === "string"
						? ((parsed as Record<string, unknown>).passcode as string)
						: "";
				if (!validatePasscode(submitted)) {
					recordFailedAttempt(ip);
					res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ error: "Invalid passcode." }));
					return;
				}
				clearRateLimit(ip);
				const token = issueSession();
				const cookieFlags = [
					`kanban_session=${token}`,
					"HttpOnly",
					"SameSite=Strict",
					"Path=/",
					`Max-Age=${24 * 60 * 60}`,
					...(tlsConfig !== null ? ["Secure"] : []),
				].join("; ");
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
					"Set-Cookie": cookieFlags,
				});
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (passcodeActive) {
				// Check session cookie (browser flow) first, then internal bearer token (CLI flow).
				const sessionToken = extractSessionTokenFromCookie(req.headers.cookie);
				const sessionAuth = sessionToken !== null && validateSession(sessionToken);
				const bearerToken = extractBearerToken(req.headers.authorization);
				const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
				const authenticated = sessionAuth || internalAuth;
				if (!authenticated) {
					// Static assets (JS, CSS, images, fonts, icons, manifest) are served
					// freely even when unauthenticated. They contain no user data and are
					// required for the React app to boot and render the passcode gate.
					// Only API routes are hard-blocked; index.html is served normally so
					// PasscodeGateProvider in React can intercept before any API calls.
					if (pathname.startsWith("/api/")) {
						res.writeHead(401, {
							"Content-Type": "application/json; charset=utf-8",
							"Cache-Control": "no-store",
						});
						res.end(JSON.stringify({ error: "Authentication required." }));
						return;
					}
					// Fall through — let the normal asset/index.html serving below handle it.
					// PasscodeGateProvider in main.tsx will render the gate before any
					// authenticated API calls are made.
				}
			}
			// ── End passcode gate ──────────────────────────────────────────────

			if (isShortcutPortProxyPath(pathname)) {
				await handleShortcutPortProxyRequest(req, res);
				return;
			}
			if (pathname.startsWith("/api/trpc")) {
				await trpcHttpHandler(req, res);
				return;
			}
			if (pathname.startsWith("/api/")) {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"error":"Not found"}');
				return;
			}

			const asset = await readAsset(webUiDir, pathname);
			res.writeHead(200, {
				"Content-Type": asset.contentType,
				"Cache-Control": "no-store",
			});
			res.end(asset.content);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
		}
	};
	const server = tlsConfig
		? createHttpsServer({ key: tlsConfig.key, cert: tlsConfig.cert }, requestHandler)
		: createServer(requestHandler);
	server.on("upgrade", (request, socket, head) => {
		let requestUrl: URL;
		try {
			requestUrl = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
		} catch {
			socket.destroy();
			return;
		}
		if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
			return;
		}
		// ── Passcode gate for WebSocket upgrades (remote mode only) ──────────
		const passcodeActive = isRemoteMode && isPasscodeEnabled();
		if (passcodeActive) {
			const sessionToken = extractSessionTokenFromCookie(request.headers.cookie);
			const sessionAuth = sessionToken !== null && validateSession(sessionToken);
			const bearerToken = extractBearerToken(request.headers.authorization);
			const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
			if (!sessionAuth && !internalAuth) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
		}
		// ── End passcode gate ─────────────────────────────────────────────────
		(request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled = true;
		const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId")?.trim() || null;
		void authorizeWorkspaceUpgrade(request, requestedWorkspaceId).then((allowed) => {
			if (!allowed) {
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedWorkspaceId });
			void recordBrowserUpgrade(request, requestUrl, null).catch(() => undefined);
		});
	});
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		server,
		resolveTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
		isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
		isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
		validateUpgradeSession:
			isRemoteMode && isPasscodeEnabled()
				? (cookieHeader) => {
						const token = extractSessionTokenFromCookie(cookieHeader);
						return token !== null && validateSession(token);
					}
				: undefined,
		authorizeUpgrade: async (request, workspaceId) => await authorizeWorkspaceUpgrade(request, workspaceId),
		onViewerUpgrade: (request, url, terminal) =>
			void recordBrowserUpgrade(request, url, terminal).catch(() => undefined),
	});
	server.on("upgrade", (request, socket) => {
		const handled = (request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled;
		if (handled) {
			return;
		}
		socket.destroy();
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(getKanbanRuntimePort(), getKanbanRuntimeHost(), () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to start local server.");
	}
	orphanProcessSweeper.start();
	providerDispatcher.start();
	clineTurnMonitor.start();
	clineLemonadeContextSync.start();
	const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
	const url = activeWorkspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimeOrigin();

	return {
		url,
		taskTrashWorkflow,
		handleWatchdogRequest,
		typedInputHold,
		runPipelineAction,
		isolation,
		close: async () => {
			await efficiencyObserver.close();
			integrationService.close();
			unsubscribeObjectiveActivity();
			await objectiveReconciler.close();
			providerDispatcher.close();
			messageNotices.close();
			typedInputHold.close();
			orchestratorInbox.close();
			clearInterval(credentialSweep);
			orphanProcessSweeper.close();
			clineTurnMonitor.close();
			clineLemonadeContextSync.close();
			unsubscribeTaskTokenUsageActivity();
			taskTokenUsageMonitor.close();
			await deps.runtimeStateHub.close();
			await terminalWebSocketBridge.close();
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			});
		},
	};
}
