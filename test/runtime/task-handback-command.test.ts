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

	it.each([
		["stalled", "no verdict"],
		["qa_agent_error", "the QA agent's own runs failed"],
	])(
		"after a STALLED escalation (%s) it moves the card to Review for a new QA round (issue #16)",
		async (cause, why) => {
			await withTemporaryKanbanHome(async () => {
				harness.store = createWorkspaceStateStore({
					board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
					sessions: {},
					revision: 1,
				});
				await createPipelineStateStore().update("ws-1", (state) => {
					state.cards.d1111 = {
						qaCreated: "snap-1",
						qaCard: "qa001",
						qaflow: {
							handled: ["r1|STALLED|x"],
							escalated: { ...ESCALATED, round: 1, cause, reason: "QA stalled" },
						},
					};
					return state;
				});

				const result = await handbackTask({
					cwd: "/repo",
					taskId: "d1111",
					note: "QA model fixed",
					extraRounds: 0,
				});

				expect(result).toMatchObject({ ok: true, task: { id: "d1111", column: "review" } });
				expect(result.message).toContain("QA gate QAs its current snapshot again with the kit's current QA model");
				expect(findCardInBoard(harness.store.stored.board, "d1111")).toMatchObject({
					columnId: "review",
					card: { title: "Wishlist" },
				});
				// The gate's one-QA-card-per-snapshot mark goes; the old QA card stays recorded.
				const entry = (await createPipelineStateStore().load("ws-1")).cards.d1111;
				expect(entry?.qaCreated).toBeUndefined();
				expect(entry?.qaCard).toBe("qa001");
				expect(readEscalationRecord(readQaflow(entry))).toBeNull();
				const qaLog = readFileSync(getPipelineQaLogPath("ws-1"), "utf8");
				expect(qaLog).toContain("## HANDBACK d1111: back to the pipeline for a new QA round\n");
				expect(qaLog).toContain(`STALLED QA round (${why})`);
			});
		},
	);

	it("refuses --extra-rounds after a STALLED escalation, changing nothing", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111", { ...ESCALATED, cause: "stalled", reason: "QA stalled" });

			await expect(handbackTask({ cwd: "/repo", taskId: "d1111", note: "retry", extraRounds: 1 })).rejects.toThrow(
				/escalated over a STALLED QA round, not a FAIL .*Hand it back without --extra-rounds: it goes to Review/u,
			);
			expect(readEscalationRecord(readQaflow((await createPipelineStateStore().load("ws-1")).cards.d1111))).toEqual({
				...ESCALATED,
				cause: "stalled",
				reason: "QA stalled",
			});
			expect(findCardInBoard(harness.store.stored.board, "d1111")?.columnId).toBe("backlog");
		});
	});

	it("keeps a card in Backlog after a STALLED escalation to another model: its sibling has the task", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111", {
				...ESCALATED,
				cause: "stalled",
				reason: "QA stalled",
				to: { agentId: "codex", model: { modelId: "gpt-x" } },
				sibling: { taskId: "s0001", tag: "preserve/d1111-x", started: true },
			});

			const result = await handbackTask({ cwd: "/repo", taskId: "d1111", note: "keep it", extraRounds: 0 });

			expect(findCardInBoard(harness.store.stored.board, "d1111")?.columnId).toBe("backlog");
			expect(result.message).toBe("Escalation cleared, no extra rounds: restart or rework the card yourself.");
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

	it("hands back a decided runoff's winner whose land conflicted: it goes to Review for the rebase rework", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "w0001", title: "BLOCKED: Promos" })] }),
				sessions: {},
				revision: 1,
			});
			// 6f756 (10/08): the runoff's winner, its land conflicted, and its rebase rework was escalated.
			await escalate("w0001", {
				at: "2026-10-08T01:14:38.000Z",
				round: 2,
				reason: "the rework came back unchanged",
				cause: "unchanged",
				to: "orchestrator",
			});
			const runoff = {
				name: "tier2-promos",
				cards: ["w0001", "l0001"],
				decided: "2026-10-08T01:04:17.000Z",
				winner: "w0001",
				actions: { w0001: "land conflict: sent back for a rebase", l0001: "discarded, tag preserve/l0001-m" },
			};
			const path = writeRunoffs([runoff]);

			const result = await handbackTask({
				cwd: "/repo",
				taskId: "w0001",
				note: "false escalation (#4)",
				extraRounds: 1,
			});

			expect(result).toMatchObject({ ok: true, task: { id: "w0001", column: "review" } });
			expect(result.message).toContain("the pipeline reworks the card's last FAIL once it is in Review");
			expect(result).not.toHaveProperty("runoffReopened");
			expect(findCardInBoard(harness.store.stored.board, "w0001")).toMatchObject({
				columnId: "review",
				card: { title: "Promos" },
			});
			expect(
				readEscalationRecord(readQaflow((await createPipelineStateStore().load("ws-1")).cards.w0001)),
			).toBeNull();
			// The decision stands: the loser stays a loser.
			expect((await readRunoffs(path)).runoffs).toMatchObject([{ decided: runoff.decided, winner: "w0001" }]);
			await escalate("l0001");
			await expect(handbackTask({ cwd: "/repo", taskId: "l0001", note: "retry", extraRounds: 1 })).rejects.toThrow(
				"which is decided (winner w0001); handing it back would let it land too. The runoff's decision is final: discard it (kanban task done --task-id l0001 --discard), and to use its work, start a new card from its preserve/l0001-<model> tag.",
			);
		});
	});

	it("hands back a card of an open runoff as before, leaving the runoff open", async () => {
		await withTemporaryKanbanHome(async () => {
			harness.store = createWorkspaceStateStore({
				board: createBoard({ backlog: [createCard({ id: "d1111", title: "BLOCKED: Wishlist" })] }),
				sessions: {},
				revision: 1,
			});
			await escalate("d1111");
			const path = writeRunoffs([{ name: "tier2-coupons", cards: ["d1111", "s0001"], decided: null }]);

			const result = await handbackTask({ cwd: "/repo", taskId: "d1111", note: "retry", extraRounds: 1 });

			expect(result).toMatchObject({ ok: true, task: { id: "d1111", column: "review" } });
			expect(result).not.toHaveProperty("runoffReopened");
			expect((await readRunoffs(path)).runoffs).toMatchObject([{ name: "tier2-coupons", decided: null }]);
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
