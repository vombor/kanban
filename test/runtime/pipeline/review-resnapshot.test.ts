// Issue #20 (foo f0ba7, 2026-10-09): a dev card's first turn changed nothing (its plan spec wasn't on main yet), so
// its snapshot had no changes. The orchestrator's messages then made the agent do the work in the same session while
// the card stayed in Review: its turns ended through hooks with no column or state change. Each was only logged as
// "waiting for the Review to settle", and no snapshot or QA card followed for 2.5 h. These run the pipeline worker
// with the real submission stage on a temp repo and the real QA gate.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { readEmptyDiff } from "../../../src/pipeline/empty-diff";
import { recordResubmitRequest } from "../../../src/pipeline/resubmit";
import { createSubmissionStage } from "../../../src/pipeline/submission-stage";
import { createRepoWithWorktree } from "../../utilities/git-repo";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-09T06:04:52.000Z");
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } };
const DEV = createCard({ id: "f0ba7", updatedAt: T0 - 120_000 });

describe("a turn that ends while the card is already in Review (issue #20)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function setup() {
		const repo = createRepoWithWorktree();
		cleanups.push(repo.cleanup);
		let now = T0;
		const stage = createSubmissionStage({
			checks: { enqueue: () => "queued" },
			resolveWorktree: async () => repo.worktreePath,
			recordEmptyDiff: async (workspaceId, taskId, record) => {
				await harness.store.update(workspaceId, (state) => {
					const { emptyDiff: _previous, ...entry } = state.cards[taskId] ?? {};
					return {
						...state,
						cards: { ...state.cards, [taskId]: record ? { ...entry, emptyDiff: record } : entry },
					};
				});
			},
			now: () => now,
		});
		const harness = createPipelineWorkerHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			clock: () => now,
			inspectSubmission: stage.inspect,
		});
		cleanups.push(harness.cleanup);
		const send = async (session: Partial<RuntimeTaskSessionSummary>) =>
			await harness.send(
				createSnapshot({
					workspaceId: "foo",
					board: createBoard({ review: [DEV] }),
					selectedAgentId: "codex",
					sessions: [
						{
							taskId: DEV.id,
							agentId: "codex",
							state: "awaiting_review",
							reviewReason: "hook",
							live: true,
							...session,
						},
					],
				}),
			);
		const qaCards = () => harness.actions.filter((action) => action.kind === "createTask");
		return {
			repo,
			harness,
			send,
			qaCards,
			setNow: (next: number) => {
				now = next;
			},
		};
	}

	it("snapshots the settled turn and QAs it after an earlier no-changes snapshot", async () => {
		const { repo, harness, send, qaCards, setNow } = setup();
		const firstTurn = { startedAt: T0 - 600_000, stateChangedAt: T0 - 60_000, lastHookAt: T0 - 60_000 };

		// 06:04:52: the first turn changed nothing.
		await send(firstTurn);
		expect(harness.readCardDecisions("foo", "snapshot").at(-1)?.note).toContain("no changes against main");
		expect(readEmptyDiff((await harness.store.load("foo")).cards[DEV.id])).toMatchObject({ ran: true });
		expect(qaCards()).toEqual([]);

		// The agent works in the same session; the card never leaves Review and the session never shows running. Its
		// turn ends through a hook at 06:26: moments later the Review hasn't settled.
		writeFileSync(join(repo.worktreePath, "schema.prisma"), "model Loyalty {}\n");
		const turnEnd = T0 + 21 * 60_000;
		setNow(turnEnd + 2_000);
		await send({ ...firstTurn, lastHookAt: turnEnd });
		expect(harness.readCardDecisions("foo").at(-1)?.note).toBe(
			"the turn ended moments ago; QA waits for the Review to settle",
		);
		expect(qaCards()).toEqual([]);

		// Once it has settled: a new snapshot, the empty-diff record goes, and the QA gate gets the card.
		setNow(turnEnd + 20_000);
		await send({ ...firstTurn, lastHookAt: turnEnd });
		expect(harness.readCardDecisions("foo", "snapshot").at(-1)).toMatchObject({ outcome: "acted" });
		expect(readEmptyDiff((await harness.store.load("foo")).cards[DEV.id])).toBeNull();
		expect(qaCards()).toHaveLength(1);
		expect(qaCards()[0]).toMatchObject({ task: { role: "qa", reviewsTaskId: DEV.id } });
	});

	it("kanban task resubmit's request snapshots a card whose Review clock never moved", async () => {
		const { repo, harness, send, qaCards } = setup();
		const turn = { startedAt: T0 - 600_000, stateChangedAt: T0 - 60_000, lastHookAt: T0 - 60_000 };
		await send(turn);
		// Work that came with no hook at all (an agent with no hook for it, or a person in the worktree).
		writeFileSync(join(repo.worktreePath, "schema.prisma"), "model Loyalty {}\n");
		await send(turn);
		expect(qaCards()).toEqual([]);

		await recordResubmitRequest(harness.store, {
			workspaceId: "foo",
			taskId: DEV.id,
			request: { at: new Date(T0).toISOString(), by: "orchestrator __home_agent__:foo:claude" },
		});
		await send(turn);
		expect(qaCards()).toHaveLength(1);
	});
});
