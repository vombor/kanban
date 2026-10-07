import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { getDetailTerminalTaskId } from "../../src/core/detail-terminal-session";
import { createHomeAgentSessionId } from "../../src/core/home-agent-session";
import { deleteTasksFromBoard } from "../../src/core/task-board-mutations";
import { planRestartRecovery } from "../../src/pipeline/restart-recovery";
import { createSessionSummaryPersister } from "../../src/server/session-summary-persister";
import type { WorkspaceStateConflictError } from "../../src/state/workspace-state";
import {
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	loadWorkspaceContextById,
	loadWorkspaceState,
	mutateWorkspaceState,
	persistWorkspaceSessionSummaries,
	removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles,
	saveWorkspaceState,
	saveWorkspaceStateReportingAddedCards,
} from "../../src/state/workspace-state";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function createBoard(title: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: title,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

/** createBoard's task-1 in Backlog plus task-2 in Done. */
function createBoardWithDoneCard(): RuntimeBoardData {
	const board = createBoard("Task One");
	const [card] = board.columns[0]?.cards ?? [];
	if (card) {
		board.columns[3]?.cards.push({ ...card, id: "task-2" });
	}
	return board;
}

function createSessionSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
	};
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

describe.sequential("workspace-state integration", () => {
	it("persists revision numbers and rejects stale writes", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const initial = await loadWorkspaceState(workspacePath);
				expect(initial.revision).toBe(0);

				const firstSave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					expectedRevision: initial.revision,
				});
				expect(firstSave.revision).toBe(1);
				expect(firstSave.board.columns[0]?.cards[0]?.prompt).toBe("Task One");

				const secondSave = await saveWorkspaceState(workspacePath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: firstSave.revision,
				});
				expect(secondSave.revision).toBe(2);
				expect(secondSave.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");

				await expect(
					saveWorkspaceState(workspacePath, {
						board: createBoard("Stale Task"),
						sessions: {},
						expectedRevision: firstSave.revision,
					}),
				).rejects.toMatchObject({
					name: "WorkspaceStateConflictError",
					currentRevision: secondSave.revision,
				} satisfies Partial<WorkspaceStateConflictError>);

				const loadedAfterConflict = await loadWorkspaceState(workspacePath);
				expect(loadedAfterConflict.revision).toBe(2);
				expect(loadedAfterConflict.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");
			} finally {
				cleanup();
			}
		});
	});

	it("reports the cards a browser save adds, never ones another writer stored first", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const initial = await loadWorkspaceState(workspacePath);
				const first = await saveWorkspaceStateReportingAddedCards(workspacePath, {
					board: createBoard("Task One"),
					sessions: {},
					expectedRevision: initial.revision,
				});
				expect(first.addedCards.map((card) => card.id)).toEqual(["task-1"]);

				// A CLI/pipeline write (mutateWorkspaceState) adds task-2; the browser's next save carries both.
				const mutated = await mutateWorkspaceState(workspacePath, (state) => {
					const board = structuredClone(state.board);
					const [card] = board.columns[0]?.cards ?? [];
					if (card) {
						board.columns[0]?.cards.push({ ...card, id: "task-2" });
					}
					return { board, value: null };
				});
				const resave = await saveWorkspaceStateReportingAddedCards(workspacePath, {
					board: mutated.state.board,
					sessions: {},
					expectedRevision: mutated.state.revision,
				});
				expect(resave.addedCards).toEqual([]);
				expect(resave.state.revision).toBe(mutated.state.revision + 1);
			} finally {
				cleanup();
			}
		});
	});

	it("lists and removes workspace index entries across multiple projects", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspaces-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const contextA = await loadWorkspaceContext(workspaceAPath);
				const contextB = await loadWorkspaceContext(workspaceBPath);

				const entries = await listWorkspaceIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
					[contextA.workspaceId, contextB.workspaceId].sort(),
				);

				expect(await loadWorkspaceContextById(contextA.workspaceId)).not.toBeNull();
				expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(true);
				expect(await loadWorkspaceContextById(contextA.workspaceId)).toBeNull();
				expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(false);

				const entriesAfterRemoval = await listWorkspaceIndexEntries();
				expect(entriesAfterRemoval).toHaveLength(1);
				expect(entriesAfterRemoval[0]?.workspaceId).toBe(contextB.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("keeps all workspace index entries when projects are added concurrently", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspaces-concurrent-");
			try {
				const workspaceAPath = join(sandboxRoot, "alpha");
				const workspaceBPath = join(sandboxRoot, "beta");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);

				const [contextA, contextB] = await Promise.all([
					loadWorkspaceContext(workspaceAPath),
					loadWorkspaceContext(workspaceBPath),
				]);

				const entries = await listWorkspaceIndexEntries();
				expect(entries).toHaveLength(2);
				expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
					[contextA.workspaceId, contextB.workspaceId].sort(),
				);
			} finally {
				cleanup();
			}
		});
	});

	it("creates readable workspace ids from folder names with random suffix on collisions", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-id-format-");
			try {
				const workspaceAPath = join(sandboxRoot, "one", "vscrui");
				const workspaceBPath = join(sandboxRoot, "two", "vscrui");
				const workspaceCPath = join(sandboxRoot, "three", "My Cool Repo");
				mkdirSync(workspaceAPath, { recursive: true });
				mkdirSync(workspaceBPath, { recursive: true });
				mkdirSync(workspaceCPath, { recursive: true });
				initGitRepository(workspaceAPath);
				initGitRepository(workspaceBPath);
				initGitRepository(workspaceCPath);

				const contextA = await loadWorkspaceContext(workspaceAPath);
				const contextB = await loadWorkspaceContext(workspaceBPath);
				const contextC = await loadWorkspaceContext(workspaceCPath);

				expect(contextA.workspaceId).toBe("vscrui");
				expect(contextB.workspaceId).toMatch(/^vscrui-[a-z0-9]{4}$/);
				expect(contextB.workspaceId).not.toBe(contextA.workspaceId);
				expect(contextC.workspaceId).toBe("my-cool-repo");

				const contextAAgain = await loadWorkspaceContext(workspaceAPath);
				expect(contextAAgain.workspaceId).toBe(contextA.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("can require an existing project without auto-creating workspace entries", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-autocreate-");
			try {
				const workspacePath = join(sandboxRoot, "gamma");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				await expect(
					loadWorkspaceContext(workspacePath, {
						autoCreateIfMissing: false,
					}),
				).rejects.toThrow("is not added to Kanban yet");

				const created = await loadWorkspaceContext(workspacePath);
				expect(created.repoPath).toBeTruthy();

				const existing = await loadWorkspaceContext(workspacePath, {
					autoCreateIfMissing: false,
				});
				expect(existing.workspaceId).toBe(created.workspaceId);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted board data is malformed", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-malformed-board-");
			try {
				const workspacePath = join(sandboxRoot, "project-bad-board");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const context = await loadWorkspaceContext(workspacePath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(
						{
							columns: [
								{
									id: "backlog",
									title: "Backlog",
									cards: [
										{
											prompt: "Missing ID and baseRef",
											startInPlanMode: false,
											createdAt: Date.now(),
											updatedAt: Date.now(),
										},
									],
								},
								{ id: "in_progress", title: "In Progress", cards: [] },
								{ id: "review", title: "Review", cards: [] },
								{ id: "trash", title: "Done", cards: [] },
							],
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("board.json");
				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow(/id|baseRef/);
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted sessions include unknown states", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-malformed-sessions-");
			try {
				const workspacePath = join(sandboxRoot, "project-bad-sessions");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const context = await loadWorkspaceContext(workspacePath);
				mkdirSync(context.statePath, { recursive: true });
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify(createBoard("Valid board"), null, 2),
					"utf8",
				);
				writeFileSync(
					join(context.statePath, "sessions.json"),
					JSON.stringify(
						{
							"task-1": {
								...createSessionSummary("task-1"),
								state: "not-a-valid-state",
							},
						},
						null,
						2,
					),
					"utf8",
				);

				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("sessions.json");
				await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("state");
			} finally {
				cleanup();
			}
		});
	});

	it("fails loudly when persisted workspace index data is malformed", async () => {
		await withTemporaryHome(async () => {
			mkdirSync(getWorkspacesRootPath(), { recursive: true });
			writeFileSync(
				join(getWorkspacesRootPath(), "index.json"),
				JSON.stringify(
					{
						version: 1,
						entries: {
							"workspace-a": {
								workspaceId: "workspace-a",
							},
						},
						repoPathToId: {},
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(listWorkspaceIndexEntries()).rejects.toThrow("index.json");
			await expect(listWorkspaceIndexEntries()).rejects.toThrow("repoPath");
		});
	});

	it("server-persisted summaries survive a restart without a browser, and restart recovery finds the orphan", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);
				const board = createBoard("Mid-turn card");
				const [card] = board.columns[0]?.cards.splice(0) ?? [];
				if (!card) {
					throw new Error("no card");
				}
				board.columns[2]?.cards.push(card); // Review: its turn was mid-run when the server died.
				const initial = await loadWorkspaceState(workspacePath);
				await saveWorkspaceState(workspacePath, { board, sessions: {}, expectedRevision: initial.revision });
				const { workspaceId } = await loadWorkspaceContext(workspacePath);

				// The first server: summaries change, no browser saves anything.
				const listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
				const persister = createSessionSummaryPersister({
					persist: persistWorkspaceSessionSummaries,
					intervalMs: 10,
				});
				persister.trackWorkspace(workspaceId, {
					onSummary: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				});
				const running = {
					...createSessionSummary("task-1"),
					state: "running" as const,
					startedAt: 1000,
					pid: 4242,
				};
				for (const listener of listeners) {
					listener(running);
				}
				await persister.close();

				// The next server hydrates its session manager from disk, as the workspace registry does.
				const manager = new TerminalSessionManager();
				manager.hydrateFromRecord((await loadWorkspaceState(workspacePath)).sessions);
				expect(manager.getSummary("task-1")).toMatchObject({ state: "running", pid: 4242 });

				const after = await loadWorkspaceState(workspacePath);
				const plan = planRestartRecovery({
					cards: after.board.columns.flatMap((column) =>
						column.cards.map((entry) => ({ card: entry, column: column.id })),
					),
					sessions: new Map(
						manager.listSummaries().map((summary) => [summary.taskId, { ...summary, live: false }]),
					),
					serverStartedAt: Date.now() + 1000,
					previousServerStartedAt: null,
					manifest: null,
					turnEnded: () => false,
				});
				expect(plan.orphans.map((orphan) => orphan.taskId)).toEqual(["task-1"]);
			} finally {
				cleanup();
			}
		});
	});

	it("a browser save can't roll a newer server summary back or drop one of a card it doesn't know", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);
				const initial = await loadWorkspaceState(workspacePath);
				const { workspaceId } = await loadWorkspaceContext(workspacePath);
				const base = createSessionSummary("task-1");
				const older = { ...base, state: "running" as const, updatedAt: 1000, stateChangedAt: 1000 };
				const newer = { ...base, state: "awaiting_review" as const, updatedAt: 2000, stateChangedAt: 2000 };
				const other = { ...createSessionSummary("task-2"), updatedAt: 1500 };
				const board = createBoardWithDoneCard();
				const first = await saveWorkspaceState(workspacePath, {
					board,
					sessions: {},
					expectedRevision: initial.revision,
				});

				expect(await persistWorkspaceSessionSummaries(workspaceId, { "task-1": newer, "task-2": other })).toBe(
					true,
				);
				// The browser last saw the older summary of task-1 and never saw task-2's (a Done card).
				const saved = await saveWorkspaceState(workspacePath, {
					board,
					sessions: { "task-1": older },
					expectedRevision: first.revision,
				});
				expect(saved.sessions["task-1"]).toEqual(newer);
				expect(saved.sessions["task-2"]).toEqual(other);
				const loaded = await loadWorkspaceState(workspacePath);
				expect(loaded.sessions).toEqual({ "task-1": newer, "task-2": other });
				// The server's write doesn't bump the board revision, so it never makes a browser save conflict.
				expect(loaded.revision).toBe(first.revision + 1);

				// A newer summary from the browser (e.g. shutdown's interrupted state) still wins.
				const newest = { ...newer, state: "interrupted" as const, updatedAt: 3000 };
				await saveWorkspaceState(workspacePath, { board: loaded.board, sessions: { "task-1": newest } });
				expect((await loadWorkspaceState(workspacePath)).sessions["task-1"]).toEqual(newest);

				// An older server write doesn't roll the stored one back either.
				await persistWorkspaceSessionSummaries(workspaceId, { "task-1": older });
				expect((await loadWorkspaceState(workspacePath)).sessions["task-1"]).toEqual(newest);
			} finally {
				cleanup();
			}
		});
	});

	it("prunes summaries by the board, keeping the home-agent sidebar's and a card's detail terminal's", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);
				const initial = await loadWorkspaceState(workspacePath);
				const { workspaceId } = await loadWorkspaceContext(workspacePath);
				const homeAgentId = createHomeAgentSessionId(workspaceId, "claude");
				const detailId = getDetailTerminalTaskId("task-1");
				const summaries = Object.fromEntries(
					["task-1", "task-2", "deleted-card", homeAgentId, detailId, getDetailTerminalTaskId("deleted-card")].map(
						(id) => [id, createSessionSummary(id)],
					),
				);

				// A browser save: pruned by the board being saved (task-2 is in Done and still kept).
				const saved = await saveWorkspaceState(workspacePath, {
					board: createBoardWithDoneCard(),
					sessions: summaries,
					expectedRevision: initial.revision,
				});
				const kept = ["task-1", "task-2", homeAgentId, detailId].sort();
				expect(Object.keys(saved.sessions).sort()).toEqual(kept);

				// The server's write: pruned by the stored board, so a deleted card's summary isn't written back.
				expect(await persistWorkspaceSessionSummaries(workspaceId, summaries)).toBe(true);
				expect(Object.keys((await loadWorkspaceState(workspacePath)).sessions).sort()).toEqual(kept);

				// Task delete (the CLI's `task delete` goes through mutateWorkspaceState) drops the card's summaries.
				await mutateWorkspaceState(workspacePath, (state) => ({
					board: deleteTasksFromBoard(state.board, ["task-1"]).board,
					value: null,
				}));
				expect(Object.keys((await loadWorkspaceState(workspacePath)).sessions).sort()).toEqual(
					["task-2", homeAgentId].sort(),
				);
				// A browser save without task-2 (deleted in the browser) drops its summary too; the sidebar's stays.
				const afterDelete = await loadWorkspaceState(workspacePath);
				const emptyBoard = createBoard("x");
				emptyBoard.columns[0]?.cards.splice(0);
				await saveWorkspaceState(workspacePath, {
					board: emptyBoard,
					sessions: afterDelete.sessions,
					expectedRevision: afterDelete.revision,
				});
				expect(Object.keys((await loadWorkspaceState(workspacePath)).sessions)).toEqual([homeAgentId]);
			} finally {
				cleanup();
			}
		});
	});

	it("project removal leaves no summaries behind, even with a server write after it", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-workspace-");
			try {
				const workspacePath = join(sandboxRoot, "project-a");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);
				const initial = await loadWorkspaceState(workspacePath);
				const { workspaceId } = await loadWorkspaceContext(workspacePath);
				await saveWorkspaceState(workspacePath, {
					board: createBoard("Task One"),
					sessions: { "task-1": createSessionSummary("task-1") },
					expectedRevision: initial.revision,
				});
				// The workspace registry's removal order: index entry, then the state directory.
				await removeWorkspaceIndexEntry(workspaceId);
				await removeWorkspaceStateFiles(workspaceId);
				expect(
					await persistWorkspaceSessionSummaries(workspaceId, { "task-1": createSessionSummary("task-1") }),
				).toBe(false);
				expect(existsSync(join(getWorkspacesRootPath(), workspaceId))).toBe(false);
			} finally {
				cleanup();
			}
		});
	});

	it("the server's summary write never recreates a removed workspace", async () => {
		await withTemporaryHome(async () => {
			expect(await persistWorkspaceSessionSummaries("gone", { a: createSessionSummary("a") })).toBe(false);
		});
	});
});
