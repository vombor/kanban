import { afterEach, describe, expect, it } from "vitest";
import type { QaVerdict } from "../../../src/pipeline/qa-verdict";
import { REWORK_STARTED_CHECK_MS, readEscalationRecord, readQaflow, readReworks } from "../../../src/pipeline/rework";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import {
	conflictPass,
	createReworkHarness,
	failVerdict,
	REWORK_T0,
	type ReworkHarnessOptions,
} from "../../utilities/rework-stage";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const DEV = createCard({
	id: "d1111",
	title: "Wishlist",
	prompt: "Build the wishlist.",
	agentId: "cline",
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
});
const SESSION = { taskId: "d1111", agentId: "cline" as const, modelId: "us.openai.gpt-6.1-sol" };

function kinds(actions: Array<{ kind: string; taskId?: string; task?: { taskId: string } }>) {
	return actions.map((action) => `${action.kind}:${action.taskId ?? action.task?.taskId}`);
}

describe("rework loop", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	const createHarness = (options?: ReworkHarnessOptions) => {
		const harness = createReworkHarness(options);
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("the started-check restarts a rework that never ran once, then escalates; one seen In Progress is left alone", async () => {
		const harness = createHarness();
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		harness.actions.length = 0;

		harness.setNow(REWORK_T0 + REWORK_STARTED_CHECK_MS - 1000);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(harness.actions).toEqual([]);

		harness.setNow(REWORK_T0 + REWORK_STARTED_CHECK_MS);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["resumeTask:d1111"]);

		harness.setNow(REWORK_T0 + 2 * REWORK_STARTED_CHECK_MS);
		await harness.tick({ review: [DEV] }, [SESSION]);
		expect(kinds(harness.actions)).toEqual(["resumeTask:d1111", "blockTask:d1111"]);
		expect(readEscalationRecord(readQaflow(await harness.entry("d1111")))).toMatchObject({
			cause: "never_started",
			reason: "rework round 2 never started",
		});

		// The same rework, but the board showed it In Progress: it ran, so nothing is restarted.
		const ran = createHarness();
		await ran.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await ran.tick({ review: [DEV] }, [SESSION]);
		ran.actions.length = 0;
		await ran.tick({ in_progress: [DEV] }, [{ ...SESSION, state: "running" }]);
		ran.setNow(REWORK_T0 + 3 * REWORK_STARTED_CHECK_MS);
		await ran.tick({ in_progress: [DEV] }, [{ ...SESSION, state: "running" }]);
		expect(ran.actions).toEqual([]);
		expect(readReworks(readQaflow(await ran.entry("d1111")))[0]).toMatchObject({
			leftReviewAt: "2026-10-07T10:00:00.000Z",
			sawRunningAt: "2026-10-07T10:00:00.000Z",
			startedAt: "2026-10-07T10:00:00.000Z",
		});
	});

	it("leaves a card to recovery while recovery holds it or has typed into it since the rework", async () => {
		const held = createHarness();
		await held.seed("d1111", { qaVerdicts: [failVerdict(1)], qaflow: { retryAt: "2026-10-07T10:05:00.000Z" } });
		await held.tick({ review: [DEV] }, [SESSION]);
		expect(held.actions).toEqual([]);
		expect(held.onFailCalls).toEqual([]);

		// Recovery sent a continue after the rework: the session was there, so no restart and no escalation.
		const continued = createHarness();
		await continued.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await continued.tick({ review: [DEV] }, [SESSION]);
		continued.actions.length = 0;
		const qaflow = readQaflow(await continued.entry("d1111"));
		await continued.seed("d1111", { qaflow: { ...qaflow, recoverySentAt: "2026-10-07T10:01:00.000Z" } });
		continued.setNow(REWORK_T0 + 3 * REWORK_STARTED_CHECK_MS);
		await continued.tick({ review: [DEV] }, [SESSION]);
		expect(continued.actions.map((action) => action.kind)).not.toContain("resumeTask");
		expect(continued.actions.map((action) => action.kind)).not.toContain("blockTask");
		expect(readReworks(readQaflow(await continued.entry("d1111")))[0]).toMatchObject({
			startedAt: expect.any(String),
			returned: expect.any(String),
		});
	});

	it("a rework back in Review with the same snapshot asks the kit with cause unchanged; a new snapshot waits for QA", async () => {
		const harness = createHarness({
			onFail: (input) =>
				input.cause === "unchanged"
					? {
							action: "escalate",
							to: "orchestrator",
							requireApproval: false,
							reason: "the rework came back unchanged",
						}
					: { action: "rework", clearContext: "never" },
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		await harness.tick({ in_progress: [DEV] }, [{ ...SESSION, state: "running" }]);
		harness.actions.length = 0;

		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(harness.onFailCalls.map((call) => call.cause)).toEqual(["fail", "unchanged"]);
		expect(kinds(harness.actions)).toEqual(["blockTask:d1111"]);
		expect(readReworks(readQaflow(await harness.entry("d1111")))[0]).toMatchObject({
			returnedSnapshot: "snap-d1111",
		});

		const changed = createHarness();
		await changed.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await changed.tick({ review: [DEV] }, [SESSION]);
		changed.actions.length = 0;
		changed.setSnapshot(() => "snap-new");
		await changed.tick({ review: [DEV] }, [SESSION]);
		expect(changed.actions).toEqual([]);
		expect(changed.onFailCalls).toHaveLength(1);
		expect(readReworks(readQaflow(await changed.entry("d1111")))[0]).toMatchObject({ returnedSnapshot: "snap-new" });
	});

	it("counts a rework as returned only once its Review has settled, so an autopilot flicker isn't 'unchanged'", async () => {
		const harness = createHarness({
			onFail: (input) =>
				input.cause === "unchanged"
					? { action: "escalate", to: "orchestrator", requireApproval: false, reason: "unchanged" }
					: { action: "rework", clearContext: "never" },
		});
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		await harness.tick({ in_progress: [DEV] }, [{ ...SESSION, state: "running" }]);
		harness.actions.length = 0;

		// The rework's first autopilot continuation stops for a moment, before anything is committed.
		harness.setNow(REWORK_T0 + 60_000);
		await harness.tick({ review: [DEV] }, [
			{ ...SESSION, state: "awaiting_review", stateChangedAt: REWORK_T0 + 59_900 },
		]);
		expect(harness.onFailCalls.map((call) => call.cause)).toEqual(["fail"]);
		expect(harness.actions).toEqual([]);
		expect(readReworks(readQaflow(await harness.entry("d1111")))[0]?.returned).toBeUndefined();

		// Settled: now it is back, still unchanged.
		harness.setNow(REWORK_T0 + 72_000);
		await harness.tick({ review: [DEV] }, [
			{ ...SESSION, state: "awaiting_review", stateChangedAt: REWORK_T0 + 59_900 },
		]);
		expect(harness.onFailCalls.map((call) => call.cause)).toEqual(["fail", "unchanged"]);
	});

	it("reworks a PASS that did not land because of a merge conflict, counting it as a FAIL round", async () => {
		const harness = createHarness();
		await harness.seed("d1111", conflictPass(1));

		await harness.tick({ review: [DEV] }, [SESSION]);

		expect(harness.onFailCalls).toMatchObject([{ cause: "conflict", history: { failRounds: [1] } }]);
		const text = harness.actions[1]?.kind === "deliverInput" ? harness.actions[1].text : "";
		expect(text).toContain("REWORK round 2 (QA round 1: PASS, but it does not merge;");
		expect(text).toContain("Blocking: rebase onto main: conflicts in src/cart.ts.");
		expect(readQaflow(await harness.entry("d1111"))).toMatchObject({ conflictRounds: [1], failRounds: [1] });
	});

	it("clears a big session first and sends the whole prompt; never clears on 'never' or without a clear command", async () => {
		const big = createHarness({ sessionSize: { turns: 101, lastInputTokens: 1000 } });
		await big.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await big.tick({ review: [DEV] }, [SESSION]);
		const texts = big.actions.flatMap((action) => (action.kind === "deliverInput" ? [action.text] : []));
		expect(texts[0]).toBe("/clear");
		expect(texts[1]).toMatch(/^Build the wishlist\.\n\nREWORK round 2/u);
		expect(texts[1]).toContain("Your conversation was cleared to save context");
		expect(readReworks(readQaflow(await big.entry("d1111")))[0]).toMatchObject({
			via: "chat (cleared)",
			clearedContext: true,
		});
		expect(big.events).toMatchObject([{ name: "reworkSent", event: { clearedContext: true } }]);

		const small = createHarness({ sessionSize: { turns: 10, lastInputTokens: 1000 } });
		const never = createHarness({
			sessionSize: { turns: 500, lastInputTokens: 900_000 },
			onFail: () => ({ action: "rework", clearContext: "never" }),
		});
		const noCommand = createHarness({ sessionSize: { turns: 500, lastInputTokens: 900_000 }, clearCommand: null });
		for (const harness of [small, never, noCommand]) {
			await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
			await harness.tick({ review: [DEV] }, [SESSION]);
			expect(harness.actions.filter((action) => action.kind === "deliverInput")).toHaveLength(1);
		}
	});

	it("warns in the QA log when the rework session runs another model than the card's", async () => {
		const harness = createHarness();
		await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
		await harness.tick({ review: [DEV] }, [SESSION]);
		await harness.tick({ in_progress: [DEV] }, [{ ...SESSION, state: "running", modelId: "us.moonshot.kimi-k3" }]);
		expect(harness.readQaLog()).toContain(
			"## Kanban WARNING d1111: the rework session runs us.moonshot.kimi-k3, not the card's bedrock/us.openai.gpt-6.1-sol",
		);
	});
});

describe("rework loop in the pipeline worker (team kit)", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	const failVerdictFile = (round: number): QaVerdict => ({
		verdict: "FAIL",
		scores: null,
		blocking: [`blocker ${round}`],
		visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
		notes: "",
		log: `- Blocking: blocker ${round}`,
	});

	it("QA FAIL → same-model rework; the third FAIL goes to the orchestrator when the kit's qaFails trigger is off", async () => {
		const harness = createPipelineWorkerHarness({
			config: {
				workspaces: {
					foo: { landing: { mode: "qa" }, kit: { name: "team", overrides: { "fallback.on.qaFails": false } } },
				},
			},
			worktree: () => "/worktrees/d1111",
		});
		harnesses.push(harness);
		const send = async (
			columns: Parameters<typeof createBoard>[0],
			sessions: Parameters<typeof createSnapshot>[0]["sessions"] = [SESSION],
		) =>
			await harness.send(
				createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId: "claude", sessions }),
			);

		for (const round of [1, 2, 3]) {
			const qaId = `qa00${round}`;
			harness.setSnapshot((taskId) => `snap-${taskId}-r${round}`);
			await send({ review: [DEV] });
			await send({ backlog: [createCard({ id: qaId, role: "qa", reviewsTaskId: "d1111" })], review: [DEV] });
			harness.setVerdict(`/tmp/kanban-qa-out/${qaId}`, { kind: "ok", verdict: failVerdictFile(round) });
			await send({ review: [DEV, createCard({ id: qaId, role: "qa", reviewsTaskId: "d1111" })] });
			if (round < 3) {
				// The rework ran: In Progress, then back in Review with a new snapshot for the next QA round.
				await send({ in_progress: [DEV] }, [{ ...SESSION, state: "running" }]);
			}
		}

		const reworks = harness.actions.filter((action) => action.kind === "updateTask");
		expect(reworks).toHaveLength(2);
		expect(harness.stagedNotes.map((notes) => notes.round)).toEqual([1, 2]);
		const escalated = readEscalationRecord(readQaflow((await harness.store.load("foo")).cards.d1111));
		expect(escalated).toMatchObject({ round: 3, to: "orchestrator", cause: "fail" });
		expect(harness.actions.at(-1)).toMatchObject({ kind: "blockTask", taskId: "d1111" });
		expect(harness.events.map((event) => event.name)).toEqual([
			"verdictRecorded",
			"reworkSent",
			"verdictRecorded",
			"reworkSent",
			"verdictRecorded",
			"escalated",
		]);
		expect(harness.readCardDecisions("foo", "rework").map((record) => record.note)).toEqual([
			expect.stringContaining("REWORK round 2 (1/2): typed into its own session"),
			expect.stringContaining("back in Review after rework round 2"),
			expect.stringContaining("REWORK round 3 (2/2): typed into its own session"),
			expect.stringContaining("back in Review after rework round 3"),
			expect.stringContaining("escalated to the orchestrator (3 FAIL rounds (rounds 1, 2, 3))"),
		]);
	});

	it("does nothing in shadow", async () => {
		const harness = createPipelineWorkerHarness({
			config: {
				workspaces: {
					foo: {
						landing: { mode: "qa" },
						kit: { name: "team" },
						models: { allowProvisional: true },
						pipeline: { shadow: true },
					},
				},
			},
		});
		harnesses.push(harness);
		await harness.store.update("foo", (state) => {
			state.cards.d1111 = { qaVerdicts: [failVerdict(1, { at: Date.now() + 60_000 })] };
			return state;
		});
		await harness.send(
			createSnapshot({ workspaceId: "foo", board: createBoard({ review: [DEV] }), selectedAgentId: "claude" }),
		);
		expect(harness.actions).toEqual([]);
		expect(harness.readCardDecisions("foo", "rework")).toEqual([]);
	});
});
