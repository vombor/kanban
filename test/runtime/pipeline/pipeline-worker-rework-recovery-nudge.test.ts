// A rework that recovery nudges is not "came back unchanged" (foo 552ba/64a2d, 2026-10-08, #4): a rework round after
// a land conflict ended on a "model doesn't support images" reply, recovery cleared and resent the card prompt, and
// the rework stage escalated the card 11-15 ms later in the same evaluation, so the redone rework never reached QA.
// These run the real recovery stage in the pipeline worker, so the order between recovery and the rework stage is
// the worker's own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { applyRecoveryPatches } from "../../../src/pipeline/recovery-runtime";
import { createRecoveryStage, type RecoveryAction } from "../../../src/pipeline/recovery-stage";
import { readEscalationRecord, readQaflow, readReworks } from "../../../src/pipeline/rework";
import type { ClineSessionDetail } from "../../../src/terminal/cline-session-files";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { conflictPass } from "../../utilities/rework-stage";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const CONFIG = {
	workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } } },
	pipeline: { recovery: { mode: "on" } },
};
const DEV = createCard({
	id: "d1111",
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

const NO_IMAGES = "Error: this model does not support image input";
const DONE = "Rebased onto main and resolved the conflict.\nSTATUS: DONE";

describe("pipeline worker: a rework recovery nudges", () => {
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
		let harness: ReturnType<typeof createPipelineWorkerHarness> | null = null;
		harness = createPipelineWorkerHarness({
			config: CONFIG,
			clock: () => Date.now(),
			worktree: () => "/wt/d1111",
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
							modelId: "us.openai.gpt-6.1-sol",
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
		const entry = async () => (await h.store.load("foo")).cards[DEV.id];
		const nudges = () => deliveries.filter((action) => action.kind === "deliver");
		const blocks = () => h.actions.filter((action) => action.kind === "blockTask");
		/** A QA PASS whose land conflicted, its rework sent and seen running, then the rework turn's end. */
		const runReworkRound = async (lastReply: string) => {
			// After the state's `since` (the first load), or the rework stage leaves the conflict as history.
			await h.store.load("foo");
			vi.advanceTimersByTime(1_000);
			const conflict = conflictPass(1);
			const qaVerdicts = conflict.qaVerdicts.map((verdict) => ({ ...verdict, at: Date.now() }));
			const qaPass = { ...conflict.qaPass, at: Date.now() + 1_000 };
			vi.advanceTimersByTime(2_000);
			await h.store.update("foo", (state) => {
				state.cards[DEV.id] = { qaVerdicts, qaPass };
				return state;
			});
			h.setSnapshot(() => qaPass.snapshot);
			await send({ review: [DEV] }, { stateChangedAt: T0 - 60_000 });
			expect(readReworks(readQaflow(await entry()))).toHaveLength(1);
			vi.advanceTimersByTime(10_000);
			await send({ in_progress: [DEV] }, { stateChangedAt: Date.now(), state: "running" });
			// The rework turn ends early, before it committed anything: the snapshot is the reviewed one.
			vi.advanceTimersByTime(60_000);
			const turnEnded = Date.now();
			detail = reply(lastReply, turnEnded);
			vi.advanceTimersByTime(13_000);
			await send({ review: [DEV] }, { stateChangedAt: turnEnded });
			return turnEnded;
		};
		return {
			harness: h,
			send,
			entry,
			nudges,
			blocks,
			runReworkRound,
			setDetail: (next: ClineSessionDetail | null) => {
				detail = next;
			},
		};
	}

	it("doesn't escalate a rework as unchanged in the sweep recovery nudges it, and judges the nudged turn", async () => {
		const { harness, send, entry, nudges, blocks, runReworkRound, setDetail } = setup();
		const turnEnded = await runReworkRound(NO_IMAGES);

		// Recovery cleared and resent the card prompt; the rework stage left the card alone in the same sweep.
		expect(nudges().length).toBeGreaterThan(0);
		expect(blocks()).toEqual([]);
		const afterNudge = readQaflow(await entry());
		expect(afterNudge.recoverySentAt).toBeDefined();
		expect(readEscalationRecord(afterNudge)).toBeNull();
		expect(readReworks(afterNudge)[0]?.returned).toBeUndefined();

		// Still the old Review on the next snapshot (the nudge not seen taken yet): still waiting.
		vi.advanceTimersByTime(30_000);
		await send({ review: [DEV] }, { stateChangedAt: turnEnded });
		expect(blocks()).toEqual([]);
		expect(readReworks(readQaflow(await entry()))[0]?.returned).toBeUndefined();

		// The nudged session does the rework, commits and ends; once settled it counts as returned with new work.
		await send({ in_progress: [DEV] }, { stateChangedAt: Date.now(), state: "running" });
		vi.advanceTimersByTime(60_000);
		const redoneAt = Date.now();
		harness.setSnapshot(() => "snap-rebased");
		setDetail(reply(DONE, redoneAt));
		vi.advanceTimersByTime(13_000);
		await send({ review: [DEV] }, { stateChangedAt: redoneAt });
		expect(blocks()).toEqual([]);
		const final = readQaflow(await entry());
		expect(readEscalationRecord(final)).toBeNull();
		expect(readReworks(final)[0]).toMatchObject({ returnedSnapshot: "snap-rebased" });
	});

	it("judges the nudged turn as unchanged when it comes back with the same snapshot", async () => {
		const { send, entry, blocks, runReworkRound, setDetail } = setup();
		await runReworkRound(NO_IMAGES);
		expect(blocks()).toEqual([]);

		await send({ in_progress: [DEV] }, { stateChangedAt: Date.now(), state: "running" });
		vi.advanceTimersByTime(60_000);
		const redoneAt = Date.now();
		setDetail(reply(DONE, redoneAt));
		vi.advanceTimersByTime(13_000);
		await send({ review: [DEV] }, { stateChangedAt: redoneAt });
		expect(blocks().map((action) => ("taskId" in action ? action.taskId : ""))).toEqual([DEV.id]);
		expect(readEscalationRecord(readQaflow(await entry()))?.reason).toMatch(/unchanged/u);
	});

	it("still escalates a rework that comes back unchanged without a nudge", async () => {
		const { entry, nudges, blocks, runReworkRound } = setup();
		await runReworkRound(DONE);
		expect(nudges()).toEqual([]);
		expect(blocks().map((action) => ("taskId" in action ? action.taskId : ""))).toEqual([DEV.id]);
		expect(readEscalationRecord(readQaflow(await entry()))?.reason).toMatch(/unchanged/u);
	});
});
