// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed Cline, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { TRPCError } from "@trpc/server";
import { getWorkspacePipelineSettings, parsePipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeConfigResponse,
	RuntimeProcessSweepResponse,
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskInputDeliveryRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { resolveOrchestratorGuardrails, resolveTaskGuardrails } from "../guardrails/task-guardrails";
import { grantCoversSession } from "../isolation/grants";
import { resolveSessionIsolation } from "../isolation/isolation-paths";
import type { IsolationService } from "../isolation/isolation-service";
import {
	type AgentSessionIdentity,
	getSessionRole,
	KANBAN_SESSION_CREDENTIAL_ENV,
	KANBAN_SESSION_WORKSPACE_ENV,
} from "../isolation/session-identity";
import { readProjectShortcuts } from "../projects/project-shortcut-store";
import { openInBrowser } from "../server/browser";
import { getDebugResetTargetPaths, getProjectShortcutsPath } from "../state/kanban-home";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import { deliverTaskInput } from "../terminal/deliver-task-input";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
	/** The orphan process sweeper (src/server/orphan-process-sweeper.ts). */
	getProcessSweep: () => Promise<RuntimeProcessSweepResponse>;
	runProcessSweep: () => Promise<RuntimeProcessSweepResponse>;
	/** The `sessionSync` setting as read at startup (src/config/session-sync-config.ts); the browser follows it. */
	sessionSyncEnabled: boolean;
	/** Project isolation (src/isolation/): each launch gets a session credential and, under `enforce`, its denies. */
	isolation?: IsolationService;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

/**
 * Why a start that needs a new turn (`requireNewTurn`) is refused: the task's live session has finished its turn, so
 * startTaskSession would hand it back unchanged and the agent would do nothing (notes f423d, issue #16).
 */
function describeFinishedLiveSession(taskId: string): string {
	return `Task "${taskId}" has a live session that finished its turn (awaiting review); starting it would only reattach that session, with no new turn. To give it more work in the same conversation: kanban task send ${taskId} "<what to do>". If it was escalated over a STALLED QA round: kanban task handback --task-id ${taskId} --note "<why>" puts it back in Review for a new QA round.`;
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const buildConfigResponse = async (
		runtimeConfig: RuntimeConfigState,
		workspaceScope: RuntimeTrpcWorkspaceScope | null,
	): Promise<RuntimeConfigResponse> => {
		if (!workspaceScope) {
			return buildRuntimeConfigResponse(runtimeConfig, { sessionSyncEnabled: deps.sessionSyncEnabled });
		}
		// Read from the shortcut store on every load (not the cached config), so a change through the shortcut
		// route shows at once. A store Kanban can't read shows no shortcuts (doctor reports it; it is never rewritten),
		// so the rest of the settings still load.
		const shortcuts = await readProjectShortcuts({
			workspaceId: workspaceScope.workspaceId,
			repoPath: workspaceScope.workspacePath,
		}).catch(() => []);
		const response = buildRuntimeConfigResponse(
			runtimeConfig,
			{ sessionSyncEnabled: deps.sessionSyncEnabled },
			{ shortcuts, shortcutsPath: getProjectShortcutsPath(workspaceScope.workspaceId) },
		);
		// The UI offers "qa" cards only on a workspace with landing mode qa. A config.json it can't read means `off`.
		const landingMode = await readPipelineConfig()
			.then(({ config }) => getWorkspacePipelineSettings(config, workspaceScope.workspaceId).landing.mode)
			.catch(() => "off" as const);
		return { ...response, landingMode };
	};

	return {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return await buildConfigResponse(scopedRuntimeConfig, workspaceScope);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return await buildConfigResponse(nextRuntimeConfig, workspaceScope);
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const taskCwd = isHomeAgentSessionId(body.taskId)
					? workspaceScope.workspacePath
					: await resolveExistingTaskCwdOrEnsure({
							cwd: workspaceScope.workspacePath,
							taskId: body.taskId,
							baseRef: body.baseRef,
						});
				const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);

				// Per-task config source-of-truth precedence:
				//
				// agentId resolution (which agent runtime to use):
				//   1. previousTerminalAgentId — persisted in the terminal session summary from
				//      the last run; ensures trash-restore resumes with the same agent runtime.
				//   2. body.agentId — the card's current per-task agent override.
				//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
				//
				// agentSettings (provider/model/reasoning-effort overrides for the launch):
				//   Always taken from the card's current override object. There is no
				//   session-level persistence for these;
				//   if the user changes the model on the card, the next session launch
				//   (including trash-restore) uses the updated values.
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				// The session manager's own reuse rule: a live session whose turn ended would be handed back unchanged.
				if (
					body.requireNewTurn &&
					terminalManager.willReuseLiveSession(body.taskId) &&
					terminalManager.getSummary(body.taskId)?.state !== "running"
				) {
					return {
						ok: false,
						summary: terminalManager.getSummary(body.taskId),
						error: describeFinishedLiveSession(body.taskId),
					};
				}
				const previousTerminalAgentId = body.resumeFromTrash
					? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
					: null;
				const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
				const resolvedConfig =
					effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
						? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
						: scopedRuntimeConfig;
				const resolved = resolveAgentCommand(resolvedConfig);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				// An unreadable config.json keeps the default guardrails (on) and isolation off.
				const pipelineConfig = (await readPipelineConfig().catch(() => parsePipelineConfig({}))).config;
				const identity: AgentSessionIdentity = {
					workspaceId: workspaceScope.workspaceId,
					taskId: body.taskId,
					role: getSessionRole(body.taskId),
					agentId: resolved.agentId,
					cwd: taskCwd,
				};
				// Project isolation `enforce`: the other projects and the machine-wide config, minus the user's grants.
				const isolation = await resolveSessionIsolation({
					config: pipelineConfig,
					workspaceId: workspaceScope.workspaceId,
					projectPath: workspaceScope.workspacePath,
					entries: await listWorkspaceIndexEntries().catch(() => []),
					grantedWorkspaceIds: (deps.isolation?.grants.list() ?? [])
						.filter((grant) => grantCoversSession(grant, identity))
						.flatMap((grant) => grant.reach),
				});
				// The orchestrator (home-agent session) works across the project's worktrees: isolation only.
				const guardrails = isHomeAgentSessionId(body.taskId)
					? await resolveOrchestratorGuardrails({ projectPath: workspaceScope.workspacePath, isolation })
					: await resolveTaskGuardrails({
							config: pipelineConfig,
							isolation,
							taskId: body.taskId,
							workspaceId: workspaceScope.workspaceId,
							worktreePath: taskCwd,
							projectPath: workspaceScope.workspacePath,
							baseRef: body.baseRef,
							// The card's git action: a PR card may push its own branch (guardrails.prCardPush).
							gitAction: await loadWorkspaceBoardById(workspaceScope.workspaceId)
								.then(
									(board) =>
										board.columns.flatMap((column) => column.cards).find((card) => card.id === body.taskId)
											?.autoReviewMode ?? null,
								)
								.catch(() => null),
						});
				// A live session is handed back unchanged (the session manager's own predicate) and keeps its credential;
				// a new process gets a new one.
				const credential = deps.isolation
					? terminalManager.willReuseLiveSession(body.taskId)
						? deps.isolation.credentials.current(workspaceScope.workspaceId, body.taskId)
						: deps.isolation.issueCredential(identity)
					: null;
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
					cwd: taskCwd,
					prompt: body.prompt,
					images: body.images,
					startInPlanMode: body.startInPlanMode,
					resumeFromTrash: body.resumeFromTrash,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
					agentSettings: body.agentSettings,
					guardrails,
					...(credential
						? {
								env: {
									[KANBAN_SESSION_CREDENTIAL_ENV]: credential,
									[KANBAN_SESSION_WORKSPACE_ENV]: workspaceScope.workspaceId,
								},
							}
						: {}),
				});

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}
				return {
					ok: true,
					summary: nextSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.stopTaskSession(body.taskId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		deliverTaskInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskInputDeliveryRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				return await deliverTaskInput(terminalManager, body.taskId, body.text, {
					enter: body.enter,
					confirm: body.confirm,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					status: "error",
					evidence: null,
					enterAttempts: 0,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			const debugResetTargetPaths = getDebugResetTargetPaths();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: debugResetTargetPaths,
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		getUpdateStatus: async () => {
			return deps.getUpdateStatus();
		},
		runUpdateNow: async () => {
			return await deps.runUpdateNow();
		},
		getProcessSweep: async () => await deps.getProcessSweep(),
		runProcessSweep: async () => await deps.runProcessSweep(),
	};
}
