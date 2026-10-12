// Issue #29: after a restart, a project nobody opened in the browser was invisible to restart recovery (the worker
// host only sends managed workspaces, which were only the launch project) until some request loaded it, 1 h 48 min
// later, and the restart manifest writer then replaced `kanban restart prepare`'s manifest with an empty one.
// This runs the startup path the server runs (cli.ts) on a real temp home: the registry loads every registered
// project, the worker host's first sweep sends its snapshot with no other activity, restart recovery resumes the
// prepare manifest's card with its WIP tag, and a periodic manifest written meanwhile still lists the card.
import { stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { getWorkspacePipelineSettings, parsePipelineConfig } from "../../../src/config/pipeline-config";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../../src/config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import type { PipelineWorkspaceSnapshot } from "../../../src/pipeline/engine";
import { createRecoveryStage, type RecoveryAction } from "../../../src/pipeline/recovery-stage";
import {
	markRestartManifestPlanned,
	type RestartManifest,
	readRestartManifest,
	removeRestartManifest,
	writeRestartManifest,
} from "../../../src/pipeline/restart-recovery";
import { createPipelineWorkerHost, type PipelineWorkerChild } from "../../../src/pipeline/worker-host";
import type { PipelineHostMessage } from "../../../src/pipeline/worker-protocol";
import { createRestartManifestWriter } from "../../../src/server/restart-manifest-writer";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import { loadWorkspaceContext, loadWorkspaceStateById, saveWorkspaceState } from "../../../src/state/workspace-state";
import { describeBrokenGitRepository, hasGitRepository } from "../../../src/workspace/repo-health";
import { createRepoWithWorktree } from "../../utilities/git-repo";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function createFakeChild(): PipelineWorkerChild & { sent: PipelineHostMessage[]; ready: () => void } {
	const listeners: Array<(message: unknown) => void> = [];
	return {
		pid: 4242,
		sent: [],
		send(message) {
			this.sent.push(message);
		},
		onMessage: (listener) => {
			listeners.push(listener);
		},
		onExit: () => {},
		kill: () => {},
		ready: () => {
			for (const listener of listeners) {
				listener({ type: "ready", pid: 4242 });
			}
		},
	};
}

function runningSummary(taskId: string, workspacePath: string, startedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "cline",
		workspacePath,
		pid: 1234,
		startedAt,
		updatedAt: startedAt,
		stateChangedAt: startedAt,
		lastOutputAt: startedAt,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: "Qwen3.8-27B-GGUF-UD-Q4_K_XL",
		reasoningEffort: null,
	};
}

describe("restart recovery at server startup (issue #29)", () => {
	it("resumes a project's orphaned cards right after the start, though nothing else touched the project", async () => {
		await withTemporaryKanbanHome(async () => {
			const launch = createRepoWithWorktree("kanban-launch-");
			const notes = createRepoWithWorktree("kanban-notes-");
			try {
				const serverStartedAt = Date.now();
				const previousServerStartedAt = serverStartedAt - 3_600_000;
				const { workspaceId: launchId } = await loadWorkspaceContext(launch.repoPath);
				const { workspaceId: notesId } = await loadWorkspaceContext(notes.repoPath);
				const wipTag = "preserve/66ddd-wip-20261010T2353-restart";
				await saveWorkspaceState(notes.repoPath, {
					board: createBoard({ in_progress: [createCard({ id: "66ddd", agentId: "cline" })] }),
					sessions: { "66ddd": runningSummary("66ddd", notes.worktreePath, serverStartedAt - 10 * 60_000) },
				});
				const prepared: RestartManifest = {
					at: new Date(serverStartedAt - 60_000).toISOString(),
					kanbanStart: new Date(previousServerStartedAt).toISOString(),
					source: "prepare",
					cards: [
						{ id: "66ddd", column: "in_progress", model: "Qwen3.8-27B-GGUF-UD-Q4_K_XL", wipTag, kind: "dev" },
					],
				};
				await writeRestartManifest(notesId, prepared);

				// The server's startup (cli.ts): launched in another project, then every registered one is loaded.
				const registry = await createWorkspaceRegistry({
					cwd: launch.repoPath,
					loadGlobalRuntimeConfig,
					loadRuntimeConfig,
					hasGitRepository,
					describeBrokenGitRepository,
					pathIsDirectory,
					logError: () => {},
					onTerminalManagerHydrated: (_workspaceId, manager) => {
						manager.markOrphanedSessionsInterrupted();
					},
				});
				expect(registry.listManagedWorkspaces().map((workspace) => workspace.workspaceId)).toEqual([launchId]);
				expect((await registry.loadRegisteredWorkspaces()).sort()).toEqual([launchId, notesId].sort());

				const writer = createRestartManifestWriter({
					listWorkspaceIds: () => registry.listManagedWorkspaces().map((workspace) => workspace.workspaceId),
					loadWorkspace: async (workspaceId) => {
						const state = await loadWorkspaceStateById(workspaceId);
						const live = registry.getTerminalManagerForWorkspace(workspaceId)?.listSummaries() ?? [];
						return state
							? {
									board: state.board,
									sessions: {
										...state.sessions,
										...Object.fromEntries(live.map((entry) => [entry.taskId, entry])),
									},
								}
							: null;
					},
					serverStartedAt,
					previousServerStartedAt,
				});
				writer.start();
				// The previous server's manifest is restart recovery's until it has planned with it.
				await writer.writeAll("periodic");
				expect(await readRestartManifest(notesId)).toEqual(prepared);

				const child = createFakeChild();
				const config = parsePipelineConfig({
					workspaces: { [notesId]: { landing: { mode: "qa" } } },
					pipeline: { recovery: { mode: "on" } },
				});
				let spawned = false;
				const host = createPipelineWorkerHost({
					listWorkspaces: () => registry.listManagedWorkspaces(),
					buildSnapshot: async (workspaceId, workspacePath) => {
						const state = await loadWorkspaceStateById(workspaceId);
						const manager = registry.getTerminalManagerForWorkspace(workspaceId);
						if (!state || !manager) {
							return null;
						}
						return {
							workspaceId,
							workspacePath,
							board: state.board,
							sessions: manager.listSummaries().map((summary) => ({
								...summary,
								live: manager.hasLiveProcess(summary.taskId),
							})),
							selectedAgentId: "claude",
							serverStartedAt,
							previousServerStartedAt,
						};
					},
					readConfig: async () => config,
					spawnWorker: () => {
						spawned = true;
						return child;
					},
					sweepIntervalMs: 3_600_000,
					readPidPressure: async () => ({ pressure: false, brownout: false }),
					log: () => {},
				});
				host.start();
				await vi.waitFor(() => expect(spawned).toBe(true));
				child.ready();
				const snapshot = await vi.waitFor(() => {
					const sent = child.sent.find(
						(message): message is Extract<PipelineHostMessage, { type: "snapshot" }> =>
							message.type === "snapshot" && message.snapshot.workspaceId === notesId,
					);
					expect(sent).toBeDefined();
					return sent?.snapshot as PipelineWorkspaceSnapshot;
				});
				expect(snapshot.sessions.find((session) => session.taskId === "66ddd")).toMatchObject({
					state: "interrupted",
					live: false,
				});

				const actions: RecoveryAction[] = [];
				const records: PipelineDecisionRecord[] = [];
				let manifestDuringResume: RestartManifest | null = null;
				const stage = createRecoveryStage({
					locateWorktree: async () => notes.worktreePath,
					readSessionDetail: async () => null,
					findRunningTool: async () => null,
					canProbe: () => false,
					probe: async () => ({ up: true, detail: "" }),
					act: async (_workspaceId, action) => {
						actions.push(action);
						// A periodic write while the resumes run must not drop the card it is resuming.
						await writer.writeAll("periodic");
						manifestDuringResume = await readRestartManifest(notesId);
						return { ok: true };
					},
					cleanGeneratedReports: async () => [],
					tagRestartWip: async () => "preserve/66ddd-wip-fresh",
					repairWorktreeIndex: async () => null,
					hasTrackedChanges: async () => false,
					readManifest: readRestartManifest,
					removeManifest: removeRestartManifest,
					markManifestPlanned: async (workspaceId, planned) =>
						await markRestartManifestPlanned(workspaceId, planned),
					consumeRecoverRequest: async () => false,
					updateCards: async () => {},
					appendRecords: async (next) => {
						records.push(...next);
					},
					sleep: async () => {},
					now: Date.now,
					log: () => {},
				});
				records.push(
					...(await stage.evaluate({
						snapshot,
						settings: getWorkspacePipelineSettings(config.config, notesId),
						config: config.config,
						kitName: "default",
						state: { version: 1, since: new Date(0).toISOString(), importedFrom: null, cards: {} },
					})),
				);
				await stage.idle();

				expect(actions).toMatchObject([{ kind: "resume", taskId: "66ddd", agentId: "cline" }]);
				expect(records.find((record) => record.taskId === null)?.note).toContain("1 orphaned card(s)");
				expect(records.at(-1)?.note).toContain(`WIP tag ${wipTag}`);
				expect(manifestDuringResume).toMatchObject({
					source: "periodic",
					kanbanStart: new Date(serverStartedAt).toISOString(),
					cards: [{ id: "66ddd", column: "in_progress", wipTag: null }],
				});

				stage.close();
				await host.close();
				await writer.close();
			} finally {
				launch.cleanup();
				notes.cleanup();
			}
		});
	});
});
