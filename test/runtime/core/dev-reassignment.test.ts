import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTask, reassignTasks, registerTaskCommand } from "../../../src/commands/task";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { DEV_ASSIGNMENT_LOG_FILENAME, resolveDevAssignment } from "../../../src/kits/dev-assignment";
import { getKanbanGlobalConfigPath, getKanbanWorkspaceDataPath } from "../../../src/state/kanban-home";
import type * as WorkspaceStateModule from "../../../src/state/workspace-state";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import {
	createBoard,
	createCard,
	createWorkspaceStateStore,
	findCardInBoard,
	type WorkspaceStateStore,
} from "../../utilities/workspace-state-store";

// `kanban task reassign` (issue #14's side note): cards keep what they were created with, so after `kit apply` the
// Backlog's cards get the kit's current dev assignment only through reassign. The real command runs against an
// in-memory board, so these tests prove the cards it writes and the log lines it appends.
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

function writeKit(kit: string | null, extra: Record<string, unknown> = {}): void {
	const path = getKanbanGlobalConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	const workspace = { ...(kit ? { kit: { name: kit } } : {}), ...extra };
	writeFileSync(path, JSON.stringify({ workspaces: { [WORKSPACE_ID]: workspace } }));
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

function storedCard(taskId: string): RuntimeBoardCard | undefined {
	return harness.store ? findCardInBoard(harness.store.stored.board, taskId)?.card : undefined;
}

function useStore(cards: Parameters<typeof createBoard>[0], sessions: Record<string, RuntimeTaskSessionSummary> = {}) {
	harness.store = createWorkspaceStateStore({ board: createBoard(cards), sessions, revision: 1 });
}

const reassign = async (overrides: Partial<Parameters<typeof reassignTasks>[0]> = {}) =>
	await reassignTasks({ cwd: "/repo", target: { column: "backlog" }, ...overrides });

const statuses = (result: Record<string, unknown>) =>
	(result.tasks as Array<{ id: string; status: string }>).map((task) => [task.id, task.status]);

describe("kanban task reassign", () => {
	let stderr: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderr.mockRestore();
		harness.store = null;
	});

	it("gives a Backlog card created under the default kit the kit's dev assignment once the kit is applied", async () => {
		await withTemporaryKanbanHome(async () => {
			useStore({});
			const created = (await createTask({ cwd: "/repo", title: "Notes", prompt: "Notes" })) as {
				task: { id: string };
			};
			const taskId = created.task.id;
			expect(storedCard(taskId)?.agentId).toBeUndefined();
			expect(readLog()).toEqual([]);

			writeKit("team");
			const revision = harness.store?.stored.revision;
			const result = await reassign();
			expect(statuses(result)).toEqual([[taskId, "reassigned"]]);
			expect(storedCard(taskId)).toMatchObject({ agentId: "cline", agentSettings: TEAM_TIER3 });
			expect(harness.store?.stored.revision).toBe((revision ?? 0) + 1);
			expect(readLog()).toEqual([
				expect.objectContaining({
					taskId,
					kit: "team",
					outcome: "applied",
					source: "reassign",
					created: { agentId: "cline", agentSettings: TEAM_TIER3 },
					previous: { agentId: null, agentSettings: null },
				}),
			]);
		});
	});

	it("keeps a card's own agent or model pick, and a reasoning effort alone is no pick", async () => {
		await withTemporaryKanbanHome(async () => {
			writeKit("team");
			useStore({
				backlog: [
					createCard({ id: "claude", agentId: "claude" }),
					createCard({ id: "model", agentSettings: { modelId: "my-model" } }),
					createCard({ id: "effort", agentSettings: { reasoningEffort: "high" } }),
				],
			});
			const result = await reassign();
			expect(statuses(result)).toEqual([
				["claude", "explicit"],
				["model", "explicit"],
				["effort", "reassigned"],
			]);
			expect(storedCard("claude")).toMatchObject({ agentId: "claude" });
			expect(storedCard("model")?.agentId).toBeUndefined();
			expect(storedCard("effort")).toMatchObject({
				agentId: "cline",
				agentSettings: { ...TEAM_TIER3, reasoningEffort: "high" },
			});
			expect(readLog().map((entry) => entry.taskId)).toEqual(["effort"]);
		});
	});

	it("moves a card still on an older kit's assignment onto the current kit's, but not one the user changed", async () => {
		await withTemporaryKanbanHome(async () => {
			writeKit("team");
			useStore({});
			const first = (await createTask({ cwd: "/repo", title: "A", prompt: "A" })) as { task: { id: string } };
			const second = (await createTask({ cwd: "/repo", title: "B", prompt: "B" })) as { task: { id: string } };
			// The user picks another model for the second card after its creation.
			const store = harness.store;
			const secondCard = store ? findCardInBoard(store.stored.board, second.task.id)?.card : undefined;
			if (secondCard) {
				secondCard.agentSettings = { providerId: "bedrock", modelId: "my-model" };
			}

			writeKit("team-local");
			const expected = await resolveDevAssignment({ workspaceId: WORKSPACE_ID, title: "A", prompt: "A" });
			expect(expected).toMatchObject({ kitName: "team-local", outcome: "applied", agentId: "cline" });
			expect(expected.agentSettings?.modelId).not.toBe(TEAM_TIER3.modelId);

			const result = await reassign();
			expect(statuses(result)).toEqual([
				[second.task.id, "explicit"],
				[first.task.id, "reassigned"],
			]);
			expect(storedCard(first.task.id)).toMatchObject({ agentId: "cline", agentSettings: expected.agentSettings });
			expect(storedCard(second.task.id)?.agentSettings).toEqual({ providerId: "bedrock", modelId: "my-model" });

			// A second run finds every card where it belongs and writes nothing.
			const revision = harness.store?.stored.revision;
			const again = await reassign();
			expect(statuses(again)).toEqual([
				[second.task.id, "explicit"],
				[first.task.id, "unchanged"],
			]);
			expect(harness.store?.stored.revision).toBe(revision);
			expect(readLog().filter((entry) => entry.source === "reassign")).toHaveLength(1);
		});
	});

	it("never changes a started card or a non-dev card", async () => {
		await withTemporaryKanbanHome(async () => {
			writeKit("team");
			useStore(
				{
					backlog: [createCard({ id: "ranbefore" }), createCard({ id: "qa", role: "qa" })],
					in_progress: [createCard({ id: "running" })],
				},
				{ ranbefore: { taskId: "ranbefore", state: "idle" } as RuntimeTaskSessionSummary },
			);
			const revision = harness.store?.stored.revision;
			const result = await reassign({ target: { taskIds: ["ranbefore", "qa", "running"] } });
			expect(statuses(result)).toEqual([
				["ranbefore", "started"],
				["qa", "not_dev"],
				["running", "not_backlog"],
			]);
			for (const taskId of ["ranbefore", "qa", "running"]) {
				expect(storedCard(taskId)?.agentId).toBeUndefined();
			}
			expect(harness.store?.stored.revision).toBe(revision);
			expect(readLog()).toEqual([]);
		});
	});

	it("--dry-run reports what each card would get and changes and logs nothing", async () => {
		await withTemporaryKanbanHome(async () => {
			writeKit("team");
			useStore({ backlog: [createCard({ id: "a" })] });
			const result = await reassign({ dryRun: true });
			expect(result).toMatchObject({
				dryRun: true,
				kit: "team",
				tasks: [
					{
						id: "a",
						status: "reassigned",
						before: { agentId: null },
						after: { agentId: "cline", agentSettings: TEAM_TIER3 },
					},
				],
			});
			expect(storedCard("a")?.agentId).toBeUndefined();
			expect(harness.store?.stored.revision).toBe(1);
			expect(readLog()).toEqual([]);
		});
	});

	it("shadow: logs the proposal and leaves the card; the default kit has nothing to give", async () => {
		await withTemporaryKanbanHome(async () => {
			writeKit("team", { pipeline: { shadow: true } });
			useStore({ backlog: [createCard({ id: "a" })] });
			expect(statuses(await reassign())).toEqual([["a", "shadow"]]);
			expect(storedCard("a")?.agentId).toBeUndefined();
			expect(readLog()).toEqual([expect.objectContaining({ taskId: "a", outcome: "shadow", source: "reassign" })]);

			writeKit(null);
			expect(statuses(await reassign())).toEqual([["a", "no_proposal"]]);
			expect(storedCard("a")?.agentId).toBeUndefined();
		});
	});

	it("refuses an unknown task id without changing any card", async () => {
		await withTemporaryKanbanHome(async () => {
			writeKit("team");
			useStore({ backlog: [createCard({ id: "a" })] });
			await expect(reassign({ target: { taskIds: ["a", "missing"] } })).rejects.toThrow(
				'Task "missing" was not found',
			);
			expect(storedCard("a")?.agentId).toBeUndefined();
			expect(readLog()).toEqual([]);
		});
	});
});

describe("the task commands' reassign wiring", () => {
	let stderr: ReturnType<typeof vi.spyOn>;
	let stdout: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderr.mockRestore();
		stdout.mockRestore();
		harness.store = null;
		process.exitCode = undefined;
	});

	async function run(...args: string[]): Promise<Record<string, unknown>> {
		const program = new Command();
		program.exitOverride();
		registerTaskCommand(program);
		stdout.mockClear();
		await program.parseAsync(["node", "kanban", "task", ...args]);
		return JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
	}

	it("task update --agent-id default on a kit-routed Backlog card says how to get the kit's agent", async () => {
		await withTemporaryKanbanHome(async () => {
			writeKit("team");
			useStore({ backlog: [createCard({ id: "a", agentId: "claude" })] });
			await run("update", "--task-id", "a", "--agent-id", "default", "--provider", "default", "--model", "default");
			expect(storedCard("a")?.agentId).toBeUndefined();
			expect(stderr).toHaveBeenCalledWith(
				expect.stringContaining(
					"Card a now runs on the selected agent. Kit team assigns cline on us.openai.gpt-6.1-sol",
				),
			);

			const result = await run("reassign", "--task-id", "a");
			expect(result).toMatchObject({ ok: true, tasks: [{ id: "a", status: "reassigned" }] });
			expect(storedCard("a")).toMatchObject({ agentId: "cline", agentSettings: TEAM_TIER3 });
		});
	});

	it("task update says nothing on the default kit", async () => {
		await withTemporaryKanbanHome(async () => {
			useStore({ backlog: [createCard({ id: "a", agentId: "claude" })] });
			await run("update", "--task-id", "a", "--agent-id", "default");
			expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("task reassign"));
		});
	});

	it("reassign takes exactly one of --task-id or --column, and only the backlog column", async () => {
		await withTemporaryKanbanHome(async () => {
			useStore({ backlog: [createCard({ id: "a" })] });
			expect(await run("reassign")).toMatchObject({ ok: false, error: expect.stringContaining("exactly one of") });
			expect(await run("reassign", "--task-id", "a", "--column", "backlog")).toMatchObject({ ok: false });
			await expect(run("reassign", "--column", "review")).rejects.toThrow("Only backlog");
			expect(await run("reassign", "--task-id", "a", "b")).toMatchObject({
				ok: false,
				error: expect.stringContaining('Task "b" was not found'),
			});
		});
	});
});
