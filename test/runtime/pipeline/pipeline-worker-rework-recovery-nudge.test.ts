// A rework that recovery nudges is not "came back unchanged" (foo 552ba/64a2d, 2026-10-08, #4): a rework round after
// a land conflict ended on a "model doesn't support images" reply, recovery cleared and resent the card prompt, and
// the rework stage escalated the card 11-15 ms later in the same evaluation, so the redone rework never reached QA.
// The same for a rework turn whose whole reply is Cline's error notice (notes 6c90e/98832, 2026-10-11, #32: "No model
// loaded: <model>", "decode() failed: vk::Queue::submit: ErrorDeviceLost"): a provider retry, not an unchanged rework.
// And for a rework turn that overflowed its context ("Context size has been exceeded.") while the provider is full: it
// waits for capacity under recovery's hold, then gets the issue #26 overflow path, not an unchanged-rework escalation.
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

/** The dev card's newest Cline session: its last assistant reply, written `writtenAt` (Cline's error notice with `displayError`). */
function reply(text: string, writtenAt: number, displayError = false): ClineSessionDetail {
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
			{ role: "assistant", content, outputTokens: null, ts: null, ...(displayError ? { displayError } : {}) },
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

	/** `holders`: other In Progress cards (no session), e.g. ones holding the provider's loaded model. */
	function setup(options: { dev?: RuntimeBoardCard; holders?: () => RuntimeBoardCard[] } = {}) {
		const dev = options.dev ?? DEV;
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
					repairWorktreeIndex: async () => null,
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
			const holders = options.holders?.() ?? [];
			await h.send(
				createSnapshot({
					workspaceId: "foo",
					board: createBoard({ ...columns, in_progress: [...(columns.in_progress ?? []), ...holders] }),
					selectedAgentId: "claude",
					sessions: [
						{
							taskId: dev.id,
							agentId: "cline",
							modelId: dev.agentSettings?.modelId ?? null,
							state: devSession.state ?? "awaiting_review",
							startedAt: T0 - 30 * 60_000,
							stateChangedAt: devSession.stateChangedAt,
							workspacePath: `/wt/${dev.id}`,
							live: true,
						},
					],
				}),
			);
		};
		const entry = async () => (await h.store.load("foo")).cards[dev.id];
		const nudges = () => deliveries.filter((action) => action.kind === "deliver");
		const blocks = () => h.actions.filter((action) => action.kind === "blockTask");
		/** A QA PASS whose land conflicted, its rework sent and seen running, then the rework turn's end. */
		const runReworkRound = async (lastReply: string, displayError = false) => {
			// After the state's `since` (the first load), or the rework stage leaves the conflict as history.
			await h.store.load("foo");
			vi.advanceTimersByTime(1_000);
			const conflict = conflictPass(1);
			const qaVerdicts = conflict.qaVerdicts.map((verdict) => ({ ...verdict, at: Date.now() }));
			const qaPass = { ...conflict.qaPass, at: Date.now() + 1_000 };
			vi.advanceTimersByTime(2_000);
			await h.store.update("foo", (state) => {
				state.cards[dev.id] = { qaVerdicts, qaPass };
				return state;
			});
			h.setSnapshot(() => qaPass.snapshot);
			await send({ review: [dev] }, { stateChangedAt: T0 - 60_000 });
			expect(readReworks(readQaflow(await entry()))).toHaveLength(1);
			vi.advanceTimersByTime(10_000);
			await send({ in_progress: [dev] }, { stateChangedAt: Date.now(), state: "running" });
			// The rework turn ends early, before it committed anything: the snapshot is the reviewed one.
			vi.advanceTimersByTime(60_000);
			const turnEnded = Date.now();
			detail = reply(lastReply, turnEnded, displayError);
			vi.advanceTimersByTime(13_000);
			await send({ review: [dev] }, { stateChangedAt: turnEnded });
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

	for (const notice of [
		"No model loaded: Devstral-Small-2-24B-Instruct-2512-GGUF-Q4_K_M",
		"decode() failed: vk::Queue::submit: ErrorDeviceLost",
	]) {
		it(`holds a rework turn that ended on "${notice}" for a provider retry, then judges the retried turn`, async () => {
			const { harness, send, entry, nudges, blocks, runReworkRound, setDetail } = setup();
			const turnEnded = await runReworkRound(notice, true);

			// A provider-retry hold: nothing typed yet, no escalation, the rework not counted as returned.
			expect(nudges()).toEqual([]);
			expect(blocks()).toEqual([]);
			const held = readQaflow(await entry());
			expect(held.retryAt).toBeDefined();
			expect(held.nudges).toBeUndefined();
			expect(readEscalationRecord(held)).toBeNull();
			expect(readReworks(held)[0]?.returned).toBeUndefined();

			// The retry is due: recovery resends, and the rework stage still leaves the card alone.
			vi.advanceTimersByTime(61_000);
			await send({ review: [DEV] }, { stateChangedAt: turnEnded });
			expect(nudges().map((action) => ("text" in action ? action.text : ""))).toEqual([
				expect.stringContaining(notice),
			]);
			expect(blocks()).toEqual([]);
			expect(readReworks(readQaflow(await entry()))[0]?.returned).toBeUndefined();

			// The retried turn does the rework: back in Review with new work, it counts as returned, not unchanged.
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
	}
	describe("a rework turn that overflowed while the provider is full", () => {
		const OVERFLOW = "Context size has been exceeded.";
		const LOCAL_DEV = createCard({
			id: "d2222",
			agentId: "cline",
			agentSettings: { providerId: "lemonade", modelId: "GLM-4.7-Flash-GGUF" },
		});
		// Another In Progress card holds Lemonade's one loaded model (models.providerCapacity default: 1).
		const HOLDER = createCard({
			id: "h3333",
			agentId: "cline",
			agentSettings: { providerId: "lemonade", modelId: "gemma-4-31B-it-qat-q4_0-gguf-Q4_0" },
		});
		const clears = (deliveries: RecoveryAction[]) =>
			deliveries.filter((action) => action.kind === "deliver" && action.text.includes(OVERFLOW));

		it("holds it for capacity, then sends the overflow path instead of escalating it as unchanged", async () => {
			let holders = [HOLDER];
			const { harness, send, entry, nudges, blocks, runReworkRound, setDetail } = setup({
				dev: LOCAL_DEV,
				holders: () => holders,
			});
			const turnEnded = await runReworkRound(OVERFLOW, true);

			// Recovery's capacity hold: nothing typed, no escalation, the rework not counted as returned.
			expect(nudges()).toEqual([]);
			expect(blocks()).toEqual([]);
			const held = readQaflow(await entry());
			expect(held.capacityStop).toMatchObject({ stop: expect.stringContaining(OVERFLOW) });
			expect(held.nudges).toBeUndefined();
			expect(held.retryAt).toBeUndefined();
			expect(readEscalationRecord(held)).toBeNull();
			expect(readReworks(held)[0]?.returned).toBeUndefined();

			// Still full on the next snapshot: still held.
			vi.advanceTimersByTime(30_000);
			await send({ review: [LOCAL_DEV] }, { stateChangedAt: turnEnded });
			expect(nudges()).toEqual([]);
			expect(blocks()).toEqual([]);

			// The holder is done: recovery clears the conversation and resends the card prompt with the overflow note.
			holders = [];
			vi.advanceTimersByTime(30_000);
			await send({ review: [LOCAL_DEV] }, { stateChangedAt: turnEnded });
			expect(clears(nudges())).toHaveLength(1);
			expect(blocks()).toEqual([]);
			const sent = readQaflow(await entry());
			expect(sent.capacityStop).toBeNull();
			expect(sent.nudges).toHaveLength(1);
			expect(readEscalationRecord(sent)).toBeNull();
			expect(readReworks(sent)[0]?.returned).toBeUndefined();

			// The redone turn does the rework: it counts as returned with new work, no FAIL round or fallback.
			await send({ in_progress: [LOCAL_DEV] }, { stateChangedAt: Date.now(), state: "running" });
			vi.advanceTimersByTime(60_000);
			const redoneAt = Date.now();
			harness.setSnapshot(() => "snap-rebased");
			setDetail(reply(DONE, redoneAt));
			vi.advanceTimersByTime(13_000);
			await send({ review: [LOCAL_DEV] }, { stateChangedAt: redoneAt });
			expect(blocks()).toEqual([]);
			// Its new work gets a QA round; no sibling on another model (a fallback) is created.
			const created = harness.actions.flatMap((action) => (action.kind === "createTask" ? [action.task.role] : []));
			expect(created).toEqual(["qa"]);
			const final = readQaflow(await entry());
			expect(readEscalationRecord(final)).toBeNull();
			expect(readReworks(final)).toHaveLength(1);
			expect(readReworks(final)[0]).toMatchObject({ returnedSnapshot: "snap-rebased" });
		});

		it("sends the overflow path at once when the provider has room", async () => {
			const { entry, nudges, blocks, runReworkRound } = setup({ dev: LOCAL_DEV });
			await runReworkRound(OVERFLOW, true);
			expect(clears(nudges())).toHaveLength(1);
			expect(blocks()).toEqual([]);
			const sent = readQaflow(await entry());
			expect(sent.capacityStop).toBeUndefined();
			expect(readEscalationRecord(sent)).toBeNull();
			expect(readReworks(sent)[0]?.returned).toBeUndefined();
		});
	});
});
