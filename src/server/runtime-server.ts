import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { createClineTurnDetectorSettingsLoader } from "../config/cline-turn-detector-config";
import { createLemonadeModelListSettingsLoader } from "../config/model-lists-config";
import { createProcessReaperSettingsLoader } from "../config/process-reaper-config";
import type {
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { getDetailTerminalTaskId } from "../core/detail-terminal-session";
import { isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import {
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimeTls,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";
import { createIsolationService, type IsolationService } from "../isolation/isolation-service";
import { createMessageNoticeQueue } from "../isolation/message-notices";
import { applyIssueSync } from "../issues/issue-apply";
import type { PipelineActionRequest, PipelineActionResult } from "../pipeline/actions";
import type { PipelineEventMap } from "../pipeline/events";
import type { WatchdogActionRequest } from "../pipeline/watchdog/actions";
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
	mutateWorkspaceState,
} from "../state/workspace-state";
import { createClineTurnMonitor } from "../terminal/cline-turn-monitor";
import { deliverTaskInput } from "../terminal/deliver-task-input";
import { DEFAULT_REVIEW_SETTLE_MS } from "../terminal/review-settle";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createHooksApi } from "../trpc/hooks-api";
import { createIsolationApi } from "../trpc/isolation-api";
import { createKitSettingsApi } from "../trpc/kit-settings-api";
import { createPlansApi } from "../trpc/plans-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createRuntimeApi } from "../trpc/runtime-api";
import { createWorkspaceApi } from "../trpc/workspace-api";
import {
	deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist,
	getTaskWorktreeCandidatePaths,
} from "../workspace/task-worktree";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import { createModelListsRequestHandler } from "./model-lists-route";
import { createOrphanProcessSweeper } from "./orphan-process-sweeper";
import { createPipelineActionRunner } from "./pipeline-actions";
import { createProcessReaper, type PreparedWorktreeReap } from "./process-reaper";
import { createProcProcessTableReader, isProcessTableSupported } from "./process-table";
import { buildCallerRequest, createRequestCallerResolver } from "./request-caller";
import type { RuntimeStateHub } from "./runtime-state-hub";
import { createTaskLandingGate } from "./task-landing-gate";
import { createTaskTrashWorkflow, createTrashTaskRequestHandler, type TaskTrashWorkflow } from "./task-trash-workflow";
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
	/** Kanban landed a card (the `qa` landing step); the pipeline worker host passes it to the worker. */
	onTaskLanded?: (event: PipelineEventMap["landed"]) => void;
	/** Project isolation's state (src/isolation/isolation-service.ts); the server makes one when absent. */
	isolation?: IsolationService;
	/** `sessionSync.reviewSettleSec` in ms: orchestrator message notices wait for a settled Review. */
	reviewSettleMs?: number;
}

export interface RuntimeServer {
	/** The server-side Done workflow; the auto-review reconciler completes cards through it. */
	taskTrashWorkflow: TaskTrashWorkflow;
	/** Carries out the pipeline worker's watchdog actions (src/server/watchdog-actions.ts). */
	handleWatchdogRequest: (request: WatchdogActionRequest) => Promise<unknown>;
	/** Runs the pipeline worker's action requests (pipeline-actions.ts). */
	runPipelineAction: (request: PipelineActionRequest) => Promise<PipelineActionResult>;
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
	const { resolveRequestScope, authorizeWorkspaceUpgrade } = createRequestCallerResolver(isolation);
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
	/** Task delete, project removal and Done reap a card's processes before its worktree is deleted. */
	const prepareTaskProcessReap = async (
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<PreparedWorktreeReap> => {
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(scope.workspaceId);
		const sessionPids = [taskId, getDetailTerminalTaskId(taskId)]
			.map((sessionId) => terminalManager?.getSummary(sessionId)?.pid)
			.filter((pid): pid is number => typeof pid === "number" && pid > 0);
		const prepared = await processReaper.prepareWorktreeReap({
			taskId,
			worktreePaths: getTaskWorktreeCandidatePaths(scope.workspacePath, taskId),
			sessionPids,
		});
		return {
			reap: async () =>
				await prepared.reap().catch((error: unknown) => {
					deps.warn(
						`Could not reap processes of task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return [];
				}),
		};
	};

	const runtimeApi = createRuntimeApi({
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
			return terminalManager ? (await deliverTaskInput(terminalManager, taskId, notice)).ok : false;
		},
		settleMs: deps.reviewSettleMs ?? DEFAULT_REVIEW_SETTLE_MS,
	});
	messageNotices.start();
	// A session's credential stops working when its process ends (resolveCaller checks that too); this drops them.
	const credentialSweep = setInterval(() => void isolation.pruneCredentials().catch(() => undefined), 10_000);
	credentialSweep.unref();
	const isolationApi = createIsolationApi({
		service: isolation,
		listEntries: listWorkspaceIndexEntries,
		notices: messageNotices,
	});
	const plansApi = createPlansApi({ log: isolation.log });
	const kitSettingsApi = createKitSettingsApi({ log: isolation.log });

	const handleWatchdogRequest = createWatchdogActionHandler({
		getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
		getTerminal: getScopedTerminalManager,
		startTaskSession: async (scope, input) => await runtimeApi.startTaskSession(scope, input),
		credentials: isolation,
		runProcessSweep: async () => {
			await orphanProcessSweeper.sweep();
			return await orphanProcessSweeper.getStatus();
		},
		onBoardMutated: async (scope) =>
			await deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath),
	});

	const taskTrashWorkflow = createTaskTrashWorkflow({
		mutateWorkspaceState,
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
			runtimeApi,
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
				trashTask: handleTrashTaskRequest,
				prepareTaskProcessReap,
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
			if (handleHttpRequest(req, res).end) {
				return;
			}

			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);

			// Model lists are fetched by agent CLIs (Cline's modelsSourceUrl), which have no session cookie or token.
			// They hold only model ids and labels, so they are served ahead of the passcode gate.
			if (await handleModelListsRequest(req, res, pathname)) {
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
		if (handleSocketUpgrade(request, socket).end) {
			return;
		}

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
	clineTurnMonitor.start();
	const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
	const url = activeWorkspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimeOrigin();

	return {
		url,
		taskTrashWorkflow,
		handleWatchdogRequest,
		runPipelineAction,
		isolation,
		close: async () => {
			messageNotices.close();
			clearInterval(credentialSweep);
			orphanProcessSweeper.close();
			clineTurnMonitor.close();
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
