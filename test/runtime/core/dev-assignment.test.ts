import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTask } from "../../../src/commands/task";
import { readPipelineConfig } from "../../../src/config/pipeline-config";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeWorkspaceStateSaveRequest,
} from "../../../src/core/api-contract";
import { recordBrowserDevAssignments } from "../../../src/kits/browser-dev-assignment-log";
import {
	DEV_ASSIGNMENT_LOG_FILENAME,
	type DevAssignmentRequest,
	recordDevAssignment,
	resolveDevAssignment,
} from "../../../src/kits/dev-assignment";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import { parseLegacyAutolandLog } from "../../../src/pipeline/shadow-diff/legacy-autoland-log";
import { loadShadowDiffInput } from "../../../src/pipeline/shadow-diff/load-shadow-diff-inputs";
import { computeShadowDiff } from "../../../src/pipeline/shadow-diff/shadow-diff";
import { getKanbanGlobalConfigPath, getKanbanWorkspaceDataPath } from "../../../src/state/kanban-home";
import type * as WorkspaceStateModule from "../../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import {
	createBoard,
	createCard,
	createWorkspaceStateStore,
	type WorkspaceStateStore,
} from "../../utilities/workspace-state-store";

// P3-5 (plan §4.0, §9): a new card the creator set no agent/model on gets the workspace kit's devAssignment.
// The CLI test drives the real `createTask` against an in-memory board, so it proves the card the CLI writes.
const harness = vi.hoisted(() => ({
	store: null as null | WorkspaceStateStore,
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: { add: { mutate: async () => ({ ok: true, project: { id: "ws-1" } }) } },
		workspace: { notifyStateUpdated: { mutate: async () => ({ ok: true }) } },
	}),
	httpBatchLink: () => null,
}));

vi.mock("../../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/repo", workspaceId: "ws-1" })),
		mutateWorkspaceState: vi.fn((cwd: string, mutate: Parameters<WorkspaceStateStore["mutateWorkspaceState"]>[1]) => {
			if (!harness.store) {
				throw new Error("workspace state harness is not set up.");
			}
			return harness.store.mutateWorkspaceState(cwd, mutate);
		}),
		// The browser's save path: the board is replaced, and the cards the stored board didn't have are reported.
		saveWorkspaceStateReportingAddedCards: vi.fn(async (_cwd: string, payload: RuntimeWorkspaceStateSaveRequest) => {
			const store = harness.store;
			if (!store) {
				throw new Error("workspace state harness is not set up.");
			}
			const storedIds = new Set(store.stored.board.columns.flatMap((column) => column.cards.map((card) => card.id)));
			const addedCards = payload.board.columns.flatMap((column) =>
				column.cards.filter((card) => !storedIds.has(card.id)),
			);
			store.stored.board = structuredClone(payload.board);
			store.stored.revision += 1;
			const state = await store.getWorkspaceState();
			return { state: { ...state, git: { ...state.git, branches: ["main"] } }, addedCards };
		}),
	};
});

const WORKSPACE_ID = "ws-1";
const TEAM_TIER3 = { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" };

function writeConfig(config: Record<string, unknown>): void {
	const path = getKanbanGlobalConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

function teamWorkspace(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { workspaces: { [WORKSPACE_ID]: { kit: { name: "team" }, ...extra } } };
}

function request(overrides: Partial<DevAssignmentRequest> = {}): DevAssignmentRequest {
	return { workspaceId: WORKSPACE_ID, title: "Add coupons", prompt: "Add coupons", ...overrides };
}

function readLog(): Array<Record<string, unknown>> {
	const path = join(getKanbanWorkspaceDataPath(WORKSPACE_ID), DEV_ASSIGNMENT_LOG_FILENAME);
	if (!existsSync(path)) {
		return [];
	}
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function backlogCards(): RuntimeBoardCard[] {
	return harness.store?.stored.board.columns.find((column) => column.id === "backlog")?.cards ?? [];
}

describe("resolveDevAssignment", () => {
	it("answers nothing for a workspace on the default kit (no config at all)", async () => {
		await withTemporaryKanbanHome(async () => {
			const decision = await resolveDevAssignment(request());
			expect(decision).toMatchObject({ kitName: "default", outcome: "none", proposal: null });
			expect(decision.agentId).toBeUndefined();
			expect(decision.agentSettings).toBeUndefined();
		});
	});

	it("never inherits another workspace's kit", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({ workspaces: { other: { kit: { name: "team" } } } });
			expect((await resolveDevAssignment(request())).outcome).toBe("none");
		});
	});

	it("gives a team card Cline on the tier-3 model", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			const decision = await resolveDevAssignment(request());
			expect(decision).toMatchObject({
				kitName: "team",
				outcome: "applied",
				proposal: { agentId: "cline", agentSettings: TEAM_TIER3, tier: "tier3" },
				agentId: "cline",
				agentSettings: TEAM_TIER3,
			});
		});
	});

	it("lets an explicit agent, model or `default` agent win", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			const claude = await resolveDevAssignment(request({ agentId: "claude" }));
			expect(claude).toMatchObject({ outcome: "explicit", agentId: "claude", agentSettings: undefined });

			const model = await resolveDevAssignment(
				request({ agentSettings: { modelId: "us.anthropic.claude-opus-5-5" } }),
			);
			expect(model).toMatchObject({
				outcome: "explicit",
				agentId: undefined,
				agentSettings: { modelId: "us.anthropic.claude-opus-5-5" },
			});

			const selected = await resolveDevAssignment(request({ agentId: null }));
			expect(selected).toMatchObject({ outcome: "explicit", agentId: undefined, agentSettings: undefined });
		});
	});

	it("keeps a reasoning effort the creator set alone", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			const decision = await resolveDevAssignment(request({ agentSettings: { reasoningEffort: "high" } }));
			expect(decision).toMatchObject({
				outcome: "applied",
				agentId: "cline",
				agentSettings: { ...TEAM_TIER3, reasoningEffort: "high" },
			});
		});
	});

	it("only proposes in shadow mode", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace({ pipeline: { shadow: true } }));
			const decision = await resolveDevAssignment(request());
			expect(decision).toMatchObject({ outcome: "shadow", proposal: { agentId: "cline" } });
			expect(decision.agentId).toBeUndefined();
			expect(decision.agentSettings).toBeUndefined();
		});
	});

	it("fills the provider from models.providers when the kit names none, and only for agents that read one", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({
				models: { providers: { default: "bedrock", fallback: { "gpt-x": "openai-native" } } },
				workspaces: {
					[WORKSPACE_ID]: { kit: { name: "team", overrides: { "dev.model": { model: "gpt-x" } } } },
					plain: { kit: { name: "team", overrides: { "dev.model": { model: "gpt-y" } } } },
					claude: { kit: { name: "team", overrides: { "dev.agent": "claude", "dev.model": { model: "opus" } } } },
				},
			});
			expect((await resolveDevAssignment(request())).agentSettings).toEqual({
				providerId: "openai-native",
				modelId: "gpt-x",
			});
			expect((await resolveDevAssignment(request({ workspaceId: "plain" }))).agentSettings).toEqual({
				providerId: "bedrock",
				modelId: "gpt-y",
			});
			expect(await resolveDevAssignment(request({ workspaceId: "claude" }))).toMatchObject({
				agentId: "claude",
				agentSettings: { modelId: "opus" },
			});
		});
	});

	it("decides nothing, with an issue, when config.json can't be read", async () => {
		await withTemporaryKanbanHome(async () => {
			const path = getKanbanGlobalConfigPath();
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "{ not json");
			const decision = await resolveDevAssignment(request({ agentId: "codex" }));
			expect(decision).toMatchObject({ outcome: "none", agentId: "codex" });
			expect(decision.issues[0]).toMatch(/could not read the kit config/u);
		});
	});
});

describe("recordDevAssignment", () => {
	it("writes nothing when the kit has no proposal", async () => {
		await withTemporaryKanbanHome(async () => {
			const decision = await resolveDevAssignment(request());
			expect(await recordDevAssignment(decision, { id: "t1", title: "x" })).toBeNull();
			expect(existsSync(getKanbanWorkspaceDataPath(WORKSPACE_ID))).toBe(false);
		});
	});
});

describe("kanban task create", () => {
	let stderr: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		harness.store = createWorkspaceStateStore({ board: createBoard({}), sessions: {}, revision: 1 });
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderr.mockRestore();
		harness.store = null;
	});

	const create = async (overrides: Partial<Parameters<typeof createTask>[0]> = {}) =>
		await createTask({ cwd: "/repo", title: "Add coupons", prompt: "Add coupons", ...overrides });

	it("default kit: the card is created unchanged and nothing is logged", async () => {
		await withTemporaryKanbanHome(async () => {
			const result = await create();
			expect(result).not.toHaveProperty("devAssignment");
			const [card] = backlogCards();
			expect(card?.agentId).toBeUndefined();
			expect(card?.agentSettings).toBeUndefined();
			expect(readLog()).toEqual([]);
		});
	});

	it("team kit: the card gets Cline on the tier-3 model, and the decision is logged", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			const result = await create();
			const [card] = backlogCards();
			expect(card).toMatchObject({ agentId: "cline", agentSettings: TEAM_TIER3 });
			expect(result).toMatchObject({
				devAssignment: { kit: "team", outcome: "applied" },
				task: { agentId: "cline", agentSettings: TEAM_TIER3 },
			});
			expect(readLog()).toEqual([
				expect.objectContaining({
					taskId: card?.id,
					kit: "team",
					outcome: "applied",
					created: { agentId: "cline", agentSettings: TEAM_TIER3 },
				}),
			]);
		});
	});

	it("an explicit --agent-id claude wins over the kit", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			await create({ agentId: "claude" });
			const [card] = backlogCards();
			expect(card?.agentId).toBe("claude");
			expect(card?.agentSettings).toBeUndefined();
			expect(readLog()).toEqual([
				expect.objectContaining({
					outcome: "explicit",
					proposal: expect.objectContaining({ agentId: "cline" }),
					created: { agentId: "claude", agentSettings: null },
				}),
			]);
		});
	});

	it("--role qa: a non-dev card gets no dev assignment and keeps the creator's agent", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			const result = await create({ role: "qa", agentId: "codex" });
			const [card] = backlogCards();
			expect(card).toMatchObject({ role: "qa", agentId: "codex" });
			expect(card?.agentSettings).toBeUndefined();
			expect(result).not.toHaveProperty("devAssignment");
			expect(result).toMatchObject({ task: { role: "qa", agentId: "codex" } });
			expect(readLog()).toEqual([]);

			// Without an agent it runs on the selected agent, not on the kit's dev routing.
			await create({ title: "Triage", prompt: "Triage", role: "triage" });
			expect(backlogCards().find((candidate) => candidate.role === "triage")?.agentId).toBeUndefined();
			expect(readLog()).toEqual([]);
		});
	});

	it("shadow: the proposal is logged, not applied", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace({ pipeline: { shadow: true } }));
			const result = await create();
			const [card] = backlogCards();
			expect(card?.agentId).toBeUndefined();
			expect(card?.agentSettings).toBeUndefined();
			expect(result).toMatchObject({ devAssignment: { outcome: "shadow" } });
			expect(readLog()).toEqual([
				expect.objectContaining({
					outcome: "shadow",
					proposal: expect.objectContaining({ agentId: "cline", agentSettings: TEAM_TIER3 }),
					created: { agentId: null, agentSettings: null },
				}),
			]);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Kit team (shadow) would assign cline"));
		});
	});

	// P5-1 shadow day: the orchestrator picks every foo card's agent and model itself; the kit's proposal is logged
	// next to that choice and the shadow diff compares the two.
	it("shadow day: the orchestrator's own choices are logged next to the proposal and the shadow diff reads them", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace({ landing: { mode: "qa" }, pipeline: { shadow: true } }));
			const startedAt = Date.now();
			await create({ title: "Wishlist", agentId: "cline", agentSettings: TEAM_TIER3 });
			await create({ title: "Docs", agentId: "claude" });
			expect(readLog().map((entry) => entry.outcome)).toEqual(["explicit", "explicit"]);

			const { config } = await readPipelineConfig();
			const input = await loadShadowDiffInput({
				workspaceId: WORKSPACE_ID,
				config,
				catalog: await loadKitCatalog(),
				legacy: parseLegacyAutolandLog(""),
				since: startedAt - 60_000,
				until: Date.now() + 60_000,
				windowMs: 10 * 60_000,
				selectedAgentId: "claude",
			});
			const items = computeShadowDiff(input).items.filter((item) => item.category === "dev_assignment");
			expect(items.map((item) => [item.status, item.legacy])).toEqual([
				["same", "created on cline with us.openai.gpt-6.1-sol (set by its creator)"],
				["different", "created on claude with its default model (set by its creator)"],
			]);
			expect(items[0]?.pipeline).toBe('kit "team" proposes cline with us.openai.gpt-6.1-sol (tier3)');
		});
	});
});

describe("workspace.getDevAssignment (the create dialog's preselection)", () => {
	function createCaller() {
		const context = {
			requestedWorkspaceId: WORKSPACE_ID,
			workspaceScope: { workspaceId: WORKSPACE_ID, workspacePath: "/repo" },
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: vi.fn(),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
				trashTask: vi.fn(),
			}),
		} as unknown as RuntimeTrpcContext;
		return runtimeAppRouter.createCaller(context);
	}

	it("returns the team proposal, and `none` on the default kit", async () => {
		await withTemporaryKanbanHome(async () => {
			expect(await createCaller().workspace.getDevAssignment()).toEqual({
				kitName: "default",
				outcome: "none",
				proposal: null,
			});
			writeConfig(teamWorkspace());
			expect(await createCaller().workspace.getDevAssignment({ prompt: "x" })).toEqual({
				kitName: "team",
				outcome: "applied",
				proposal: { agentId: "cline", agentSettings: TEAM_TIER3, tier: "tier3" },
			});
		});
	});
});

// P5-1 follow-up: the browser builds new cards itself and saves the whole board, so the server logs them on save.
describe("browser-created cards (workspace.saveState)", () => {
	beforeEach(() => {
		harness.store = createWorkspaceStateStore({ board: createBoard({}), sessions: {}, revision: 1 });
	});

	afterEach(() => {
		harness.store = null;
	});

	function createCaller() {
		const context = {
			requestedWorkspaceId: WORKSPACE_ID,
			workspaceScope: { workspaceId: WORKSPACE_ID, workspacePath: "/repo" },
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: vi.fn(async () => ({ listSummaries: () => [] }) as never),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
				trashTask: vi.fn(),
			}),
		} as unknown as RuntimeTrpcContext;
		return runtimeAppRouter.createCaller(context);
	}

	function storedBoard(): RuntimeBoardData {
		if (!harness.store) {
			throw new Error("workspace state harness is not set up.");
		}
		return structuredClone(harness.store.stored.board);
	}

	function withBacklogCard(board: RuntimeBoardData, card: RuntimeBoardCard): RuntimeBoardData {
		return {
			...board,
			columns: board.columns.map((column) =>
				column.id === "backlog" ? { ...column, cards: [card, ...column.cards] } : column,
			),
		};
	}

	/** A browser save, then waits for the server's (unawaited) log write: an empty call queues behind it. */
	async function browserSave(board: RuntimeBoardData): Promise<void> {
		await createCaller().workspace.saveState({ board, sessions: {} });
		await recordBrowserDevAssignments(WORKSPACE_ID, []);
	}

	const kitCard = (id: string, overrides: Partial<RuntimeBoardCard> = {}) =>
		createCard({ id, title: `Card ${id}`, agentId: "cline", agentSettings: TEAM_TIER3, ...overrides });

	it("logs a new dev card once, with the CLI's entry shape and source browser", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			await browserSave(withBacklogCard(storedBoard(), kitCard("b1")));
			const [entry] = readLog();
			expect(readLog()).toHaveLength(1);
			expect(entry).toEqual({
				at: expect.any(String),
				workspaceId: WORKSPACE_ID,
				taskId: "b1",
				title: "Card b1",
				kit: "team",
				outcome: "applied",
				proposal: { agentId: "cline", agentSettings: TEAM_TIER3, tier: "tier3" },
				created: { agentId: "cline", agentSettings: TEAM_TIER3 },
				source: "browser",
			});

			// Re-saves (an edit, a move) don't log it again.
			const board = storedBoard();
			const [card] = board.columns[0]?.cards ?? [];
			if (card) {
				card.prompt = "Edited";
			}
			await browserSave(board);
			await browserSave(storedBoard());
			expect(readLog()).toHaveLength(1);
			// Even a card the stored board lost (and a stale save re-adds) is logged once per task id.
			await recordBrowserDevAssignments(WORKSPACE_ID, [kitCard("b1")]);
			expect(readLog()).toHaveLength(1);
		});
	});

	it("logs the user's own pick as explicit, and a Default card on the selected agent", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig({ ...teamWorkspace(), selectedAgentId: "claude" });
			let board = withBacklogCard(storedBoard(), kitCard("picked", { agentId: "codex", agentSettings: undefined }));
			board = withBacklogCard(board, kitCard("default", { agentId: undefined, agentSettings: undefined }));
			await browserSave(board);
			const byId = new Map(readLog().map((entry) => [entry.taskId, entry]));
			expect(byId.get("picked")).toMatchObject({
				outcome: "explicit",
				created: { agentId: "codex", agentSettings: null },
				source: "browser",
			});
			expect(byId.get("default")).toMatchObject({
				outcome: "explicit",
				created: { agentId: "claude", agentSettings: null },
			});
		});
	});

	it("shadow: logs the card as created, next to the proposal it wasn't given", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace({ pipeline: { shadow: true } }));
			await browserSave(
				withBacklogCard(storedBoard(), kitCard("s1", { agentId: "claude", agentSettings: undefined })),
			);
			expect(readLog()).toEqual([
				expect.objectContaining({
					taskId: "s1",
					outcome: "shadow",
					proposal: expect.objectContaining({ agentId: "cline" }),
					created: { agentId: "claude", agentSettings: null },
					source: "browser",
				}),
			]);
		});
	});

	it("never logs CLI- or pipeline-created cards as browser cards", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			await createTask({ cwd: "/repo", title: "From CLI", prompt: "From CLI" });
			// A pipeline sibling (a dev card) and a QA card, both written in-process like pipeline-actions does.
			await harness.store?.mutateWorkspaceState("/repo", (state) => ({
				board: withBacklogCard(
					withBacklogCard(state.board, kitCard("sibling")),
					kitCard("qa-1", { role: "qa", title: "QA1 abcde: check" }),
				),
				value: null,
			}));
			// The browser then saves the board it got from the server, with all of them on it.
			await browserSave(storedBoard());
			expect(readLog().map((entry) => [entry.title, entry.source])).toEqual([["From CLI", "cli"]]);
		});
	});

	it("skips non-dev cards a browser save adds", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace());
			await browserSave(withBacklogCard(storedBoard(), kitCard("t1", { role: "triage" })));
			await browserSave(withBacklogCard(storedBoard(), kitCard("q1", { title: "QA2 abcde: legacy QA card" })));
			expect(readLog()).toEqual([]);
		});
	});

	it("default kit: a browser-created card logs nothing", async () => {
		await withTemporaryKanbanHome(async () => {
			await browserSave(withBacklogCard(storedBoard(), kitCard("d1")));
			expect(existsSync(getKanbanWorkspaceDataPath(WORKSPACE_ID))).toBe(false);
		});
	});

	it("the shadow diff reads a browser entry like a CLI one", async () => {
		await withTemporaryKanbanHome(async () => {
			writeConfig(teamWorkspace({ landing: { mode: "qa" }, pipeline: { shadow: true } }));
			const startedAt = Date.now();
			await browserSave(withBacklogCard(storedBoard(), kitCard("w1", { title: "Wishlist" })));
			await browserSave(
				withBacklogCard(
					storedBoard(),
					kitCard("w2", { title: "Docs", agentId: "claude", agentSettings: undefined }),
				),
			);
			const { config } = await readPipelineConfig();
			const input = await loadShadowDiffInput({
				workspaceId: WORKSPACE_ID,
				config,
				catalog: await loadKitCatalog(),
				legacy: parseLegacyAutolandLog(""),
				since: startedAt - 60_000,
				until: Date.now() + 60_000,
				windowMs: 10 * 60_000,
				selectedAgentId: "codex",
			});
			const items = computeShadowDiff(input).items.filter((item) => item.category === "dev_assignment");
			expect(items.map((item) => [item.taskId, item.status, item.legacy])).toEqual([
				["w1", "same", "created on cline with us.openai.gpt-6.1-sol"],
				["w2", "different", "created on claude with its default model"],
			]);
		});
	});
});
