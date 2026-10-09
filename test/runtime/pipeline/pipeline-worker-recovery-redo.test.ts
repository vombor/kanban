// A turn recovery redoes is never QA'd (foo 27549, 2026-10-07): in one evaluation recovery nudged the dev card
// (`premature`, /clear + the card prompt) and the QA gate then snapshotted the same turn and queued a QA card,
// which it started on that stale snapshot once the redone turn ended. These run the real recovery stage in the
// pipeline worker, so the order between recovery, the submission stage and the QA gate is the worker's own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { readQaGateEntry } from "../../../src/pipeline/qa-gate";
import { applyRecoveryPatches } from "../../../src/pipeline/recovery-runtime";
import { createRecoveryStage, type RecoveryAction } from "../../../src/pipeline/recovery-stage";
import type { ClineSessionDetail } from "../../../src/terminal/cline-session-files";
import { createPipelineWorkerHarness, createSnapshot, type QaGateHarnessAction } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-07T10:56:00.000Z");
const CONFIG = {
	workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } } },
	pipeline: { recovery: { mode: "on" } },
};
const DEV = createCard({
	id: "d2754",
	agentId: "cline",
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
});

/** The dev card's newest Cline session: its last assistant reply, written `writtenAt`. */
function reply(text: string, writtenAt: number): ClineSessionDetail {
	const content = [{ type: "text", text }];
	return {
		snapshot: {
			sessionId: "1700_abc",
			status: "idle",
			startedAt: T0 - 30 * 60_000,
			messagesWrittenAt: writtenAt,
			lastMessage: { role: "assistant", content },
		},
		messages: [
			{ role: "user", content: [{ type: "text", text: "go" }], outputTokens: null, ts: null },
			{ role: "assistant", content, outputTokens: null, ts: null },
		],
		lastWriteAt: writtenAt,
	};
}

const PREMATURE = "Now let me look at the tests:";
const DONE = "Implemented and tested.\nSTATUS: DONE";

describe("pipeline worker: a turn recovery redoes", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
		vi.useRealTimers();
	});

	function setup() {
		let detail: ClineSessionDetail | null = null;
		const deliveries: RecoveryAction[] = [];
		const inspected: number[] = [];
		let harness: ReturnType<typeof createPipelineWorkerHarness> | null = null;
		harness = createPipelineWorkerHarness({
			config: CONFIG,
			clock: () => Date.now(),
			inspectSubmission: async (_context, { card }) => {
				if (card.id === DEV.id) {
					inspected.push(Date.now());
				}
				return { hasWork: true, records: [] };
			},
			// The real recovery stage; its server side (the PTY, the session files) is faked.
			createRecovery: () =>
				createRecoveryStage({
					locateWorktree: async (_workspacePath, card) => `/wt/${card.id}`,
					readSessionDetail: async () => detail,
					findRunningTool: async () => null,
					canProbe: () => false,
					probe: async () => ({ up: true, detail: "200" }),
					act: async (_workspaceId, action) => {
						deliveries.push(action);
						return { ok: true, status: "delivered", evidence: "output" };
					},
					cleanGeneratedReports: async () => [],
					tagRestartWip: async () => null,
					hasTrackedChanges: async () => false,
					readManifest: async () => null,
					removeManifest: async () => {},
					markManifestPlanned: async () => {},
					consumeRecoverRequest: async () => false,
					updateCards: async (workspaceId, patches) => {
						await harness?.store.update(workspaceId, (state) => ({
							...state,
							cards: applyRecoveryPatches(state.cards, patches),
						}));
					},
					appendRecords: async () => {},
					// The /clear settle time passes on the fake clock, as the 2.4 s did on foo.
					sleep: async (ms) => {
						vi.advanceTimersByTime(ms);
					},
					now: () => Date.now(),
					log: () => {},
				}),
		});
		harnesses.push(harness);
		const h = harness;
		const send = async (
			columns: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>,
			devSession: { stateChangedAt: number; state?: "running" | "awaiting_review" },
		) => {
			await h.send(
				createSnapshot({
					workspaceId: "foo",
					board: createBoard(columns),
					selectedAgentId: "claude",
					sessions: [
						{
							taskId: DEV.id,
							agentId: "cline",
							state: devSession.state ?? "awaiting_review",
							startedAt: T0 - 30 * 60_000,
							stateChangedAt: devSession.stateChangedAt,
							workspacePath: `/wt/${DEV.id}`,
							live: true,
						},
					],
				}),
			);
		};
		const gateActions = () =>
			h.actions
				.filter((action) => action.kind !== "deliverInput")
				.map((action: QaGateHarnessAction) => {
					const taskId = "taskId" in action ? action.taskId : "task" in action ? action.task.taskId : "";
					return `${action.kind}:${taskId}${action.kind === "finishTask" ? `:${action.landing}` : ""}`;
				});
		return {
			harness: h,
			deliveries,
			inspected,
			gateActions,
			send,
			setDetail: (next: ClineSessionDetail | null) => {
				detail = next;
			},
		};
	}

	it("runs recovery's nudge before the snapshot and the QA gate, and QAs the redone turn once it settles", async () => {
		const { harness, deliveries, inspected, gateActions, send, setDetail } = setup();
		const turnEnded = T0 - 20_000;
		setDetail(reply(PREMATURE, turnEnded));

		// The turn ended 20 s ago (settled): recovery resends it, so nothing snapshots or QAs it.
		await send({ review: [DEV] }, { stateChangedAt: turnEnded });
		expect(deliveries.filter((action) => action.kind === "deliver").length).toBeGreaterThan(0);
		expect(inspected).toEqual([]);
		expect(gateActions()).toEqual([]);
		expect(harness.readCardDecisions("foo", "qa_gate")).toEqual([]);
		const sentAt = (await harness.store.load("foo")).cards[DEV.id]?.qaflow as { recoverySentAt?: string };
		expect(sentAt.recoverySentAt).toBeDefined();

		// The next snapshot still shows the old Review (the nudge's text not seen taken yet): still held.
		vi.advanceTimersByTime(30_000);
		await send({ review: [DEV] }, { stateChangedAt: turnEnded });
		expect(inspected).toEqual([]);
		expect(gateActions()).toEqual([]);

		// The redone turn runs, then ends with STATUS: DONE; once its Review settles it gets the snapshot and QA.
		vi.advanceTimersByTime(60_000);
		await send({ in_progress: [DEV] }, { stateChangedAt: Date.now() - 50_000, state: "running" });
		const redoneAt = Date.now();
		setDetail(reply(DONE, redoneAt));
		await send({ review: [DEV] }, { stateChangedAt: redoneAt });
		expect(inspected).toEqual([]);
		vi.advanceTimersByTime(13_000);
		await send({ review: [DEV] }, { stateChangedAt: redoneAt });
		expect(inspected).toEqual([Date.now()]);
		expect(gateActions()).toEqual(["createTask:qa001"]);
	});

	it("supersedes a queued QA card when recovery resends the turn, and gives the redone turn a new one", async () => {
		const { harness, deliveries, gateActions, send, setDetail } = setup();
		const turnEnded = T0 - 20_000;
		// No session file yet: recovery has nothing to go on, so the QA gate queues QA for the turn.
		await send({ review: [DEV] }, { stateChangedAt: turnEnded });
		expect(gateActions()).toEqual(["createTask:qa001"]);
		const qa = createCard({ id: "qa001", role: "qa", reviewsTaskId: DEV.id });

		// The session file shows a premature stop: recovery resends the turn, and the queued QA card goes unstarted.
		setDetail(reply(PREMATURE, turnEnded));
		vi.advanceTimersByTime(5_000);
		await send({ backlog: [qa], review: [DEV] }, { stateChangedAt: turnEnded });
		expect(deliveries.filter((action) => action.kind === "deliver").length).toBeGreaterThan(0);
		expect(gateActions()).toEqual(["createTask:qa001", "finishTask:qa001:discard"]);
		const state = await harness.store.load("foo");
		expect(readQaGateEntry(state.cards.qa001)).toMatchObject({ status: "superseded", trashed: true });
		expect(state.cards[DEV.id]).not.toHaveProperty("qaCreated");
		expect(state.cards[DEV.id]).not.toHaveProperty("qaCard");
		expect(harness.readCardDecisions("foo", "qa_start")).toMatchObject([
			{
				taskId: "qa001",
				note: expect.stringMatching(/^superseded: recovery resent d2754's turn .*queued; not started/u),
			},
		]);

		// The redone turn leaves the same tree (the same snapshot commit): it still gets a QA card of its own.
		vi.advanceTimersByTime(60_000);
		const redoneAt = Date.now();
		setDetail(reply(DONE, redoneAt));
		vi.advanceTimersByTime(13_000);
		await send({ review: [DEV], trash: [qa] }, { stateChangedAt: redoneAt });
		expect(gateActions()).toEqual(["createTask:qa001", "finishTask:qa001:discard", "createTask:qa002"]);
		const next = await harness.store.load("foo");
		expect(next.cards[DEV.id]).toMatchObject({ qaCreated: `snap-${DEV.id}`, qaCard: "qa002" });
	});

	it("stops and discards a QA card already running on the old snapshot", async () => {
		const { harness, gateActions, send, setDetail } = setup();
		const turnEnded = T0 - 20_000;
		await send({ review: [DEV] }, { stateChangedAt: turnEnded });
		const qa = createCard({ id: "qa001", role: "qa", reviewsTaskId: DEV.id });
		vi.advanceTimersByTime(1_000);
		await send({ backlog: [qa], review: [DEV] }, { stateChangedAt: turnEnded });
		expect(gateActions()).toEqual(["createTask:qa001", "startTask:qa001"]);

		setDetail(reply(PREMATURE, turnEnded));
		vi.advanceTimersByTime(5_000);
		await send({ in_progress: [qa], review: [DEV] }, { stateChangedAt: turnEnded });
		expect(gateActions()).toEqual(["createTask:qa001", "startTask:qa001", "finishTask:qa001:discard"]);
		expect(harness.stoppedScratch).toHaveLength(1);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)).toMatchObject({
			status: "superseded",
			trashed: true,
		});
		expect(harness.readCardDecisions("foo", "qa_start").at(-1)?.note).toContain("(running; stopped)");
	});
});
