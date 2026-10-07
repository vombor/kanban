import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTask } from "../../../src/commands/task";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import {
	DEV_ASSIGNMENT_LOG_FILENAME,
	type DevAssignmentRequest,
	recordDevAssignment,
	resolveDevAssignment,
} from "../../../src/kits/dev-assignment";
import { getKanbanGlobalConfigPath, getKanbanWorkspaceDataPath } from "../../../src/state/kanban-home";
import type * as WorkspaceStateModule from "../../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import {
	createBoard,
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
