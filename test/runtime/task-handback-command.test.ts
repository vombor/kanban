import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { handbackTask } from "../../src/commands/task";
import { readRunoffs } from "../../src/kits/team/runoffs/runoffs-store";
import { createPipelineStateStore } from "../../src/pipeline/pipeline-state";
import { readEscalationRecord, readHandbacks, readQaflow } from "../../src/pipeline/rework";
import { getPipelineQaLogPath, getWatchdogWorkspacePaths } from "../../src/state/kanban-home";
import type * as WorkspaceStateModule from "../../src/state/workspace-state";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import {
	createBoard,
	createCard,
	createWorkspaceStateStore,
	findCardInBoard,
	type WorkspaceStateStore,
} from "../utilities/workspace-state-store";

// `kanban task handback` edits the pipeline state in-process and the board through mutateWorkspaceState; the
// runtime is only told the board changed.
const harness = vi.hoisted(() => ({
	store: null as null | WorkspaceStateStore,
	notified: 0,
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: { add: { mutate: async () => ({ ok: true, project: { id: "ws-1" } }) } },
		workspace: {
			notifyStateUpdated: {
				mutate: async () => {
					harness.notified += 1;
				},
			},
		},
	}),
	httpBatchLink: () => null,
}));

vi.mock("../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/repo", workspaceId: "ws-1" })),
		mutateWorkspaceState: vi.fn(
			async (...args: Parameters<WorkspaceStateStore["mutateWorkspaceState"]>) =>
				await (harness.store as WorkspaceStateStore).mutateWorkspaceState(...args),
		),
	};
});

const ESCALATED = { at: "2026-10-07T09:00:00.000Z", round: 3, reason: "3 FAIL rounds", to: "orchestrator" };

async function escalate(taskId: string, escalated: Record<string, unknown> = ESCALATED): Promise<void> {
	await createPipelineStateStore().update("ws-1", (state) => {
		state.cards[taskId] = { qaflow: { handled: ["r3|FAIL|x"], escalated } };
		return state;
	});
}

describe("kanban task handback", () => {
	beforeEach(() => {
		harness.notified = 0;
	});

	it("clears the escalation append-only, drops BLOCKED: and moves the card to Review with extra rounds", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111");

			const result = await handbackTask({
				cwd: "/repo",
				taskId: "d1111",
				note: "QA was flaky",
				extraRounds: 2,
				by: "user",
			});

			expect(result).toMatchObject({ ok: true, task: { id: "d1111", column: "review" } });
			expect(findCardInBoard(harness.store.stored.board, "d1111")).toMatchObject({
				columnId: "review",
				card: { title: "Wishlist" },
			});
			const qaflow = readQaflow((await createPipelineStateStore().load("ws-1")).cards.d1111);
			expect(readEscalationRecord(qaflow)).toBeNull();
			expect(qaflow.handled).toEqual(["r3|FAIL|x"]);
			expect(readHandbacks(qaflow)).toMatchObject([
				{ by: "user", note: "QA was flaky", extraRounds: 2, escalated: ESCALATED },
			]);
			expect(readFileSync(getPipelineQaLogPath("ws-1"), "utf8")).toContain(
				"## HANDBACK d1111: back to the pipeline (+2 FAIL rounds)\n",
			);
			expect(harness.notified).toBe(1);
		});
	});

	it("leaves the card in Backlog without extra rounds, and refuses a card that is not escalated", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111");

			await handbackTask({ cwd: "/repo", taskId: "d1111", note: "I'll restart it", extraRounds: 0 });
			expect(findCardInBoard(harness.store.stored.board, "d1111")).toMatchObject({
				columnId: "backlog",
				card: { title: "Wishlist" },
			});
			expect(readHandbacks(readQaflow((await createPipelineStateStore().load("ws-1")).cards.d1111))).toMatchObject([
				{ by: "orchestrator", extraRounds: 0 },
			]);

			await expect(handbackTask({ cwd: "/repo", taskId: "d1111", note: "again", extraRounds: 1 })).rejects.toThrow(
				'Task "d1111" is not escalated',
			);
			await expect(handbackTask({ cwd: "/repo", taskId: "d1111", note: " ", extraRounds: 1 })).rejects.toThrow(
				"needs a --note",
			);
		});
	});

	it("after a STALLED escalation it keeps the card in Backlog and says the pipeline won't rework it", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111", { ...ESCALATED, cause: "stalled", reason: "QA stalled" });

			const result = await handbackTask({ cwd: "/repo", taskId: "d1111", note: "retry", extraRounds: 1 });

			expect(result.message).toContain("escalated over a STALLED QA round, which the pipeline does not rework");
			expect(findCardInBoard(harness.store.stored.board, "d1111")?.columnId).toBe("backlog");
		});
	});

	const writeRunoffs = (runoffs: unknown[]) => {
		const path = getWatchdogWorkspacePaths("ws-1").runoffs;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ runoffs }));
		return path;
	};

	it("refuses a card whose runoff has a landed winner (or is bench only): its next PASS would land too", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111");
			writeRunoffs([
				{
					name: "tier2-coupons",
					cards: ["d1111", "s0001"],
					decided: "2026-10-07T09:30:00.000Z",
					winner: "s0001",
					actions: { s0001: "landed" },
				},
			]);

			await expect(handbackTask({ cwd: "/repo", taskId: "d1111", note: "retry", extraRounds: 1 })).rejects.toThrow(
				"raced in runoff tier2-coupons, which is decided (winner s0001); handing it back would let it land too",
			);
			// Nothing changed: still escalated, still BLOCKED in Backlog.
			expect(
				readEscalationRecord(readQaflow((await createPipelineStateStore().load("ws-1")).cards.d1111)),
			).not.toBeNull();
			expect(findCardInBoard(harness.store.stored.board, "d1111")).toMatchObject({
				columnId: "backlog",
				card: { title: "BLOCKED: Wishlist" },
			});

			writeRunoffs([
				{
					name: "rerun",
					cards: ["d1111", "s0001"],
					decided: "2026-10-07T09:30:00.000Z",
					winner: null,
					benchOnly: true,
				},
			]);
			await expect(handbackTask({ cwd: "/repo", taskId: "d1111", note: "retry", extraRounds: 1 })).rejects.toThrow(
				"bench only, nothing lands",
			);
		});
	});

	it("reopens a runoff decided with no winner, and says so in the QA log", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111");
			writeRunoffs([
				{ name: "tier2-coupons", cards: ["d1111", "s0001"], decided: "2026-10-07T09:30:00.000Z", winner: null },
			]);

			const result = await handbackTask({ cwd: "/repo", taskId: "d1111", note: "provider is back", extraRounds: 1 });

			expect(result).toMatchObject({ ok: true, runoffReopened: "tier2-coupons" });
			const [runoff] = (await readRunoffs(getWatchdogWorkspacePaths("ws-1").runoffs)).runoffs;
			expect(runoff?.decided).toBeUndefined();
			expect(readFileSync(getPipelineQaLogPath("ws-1"), "utf8")).toContain(
				"- Runoff tier2-coupons had no winner; reopened.",
			);
		});
	});
});
