import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { readQaGateEntry, readQaVerdictRecords } from "../../../src/pipeline/qa-gate";
import type { QaVerdict } from "../../../src/pipeline/qa-verdict";
import { createPipelineWorkerHarness, createSnapshot, type QaGateHarnessAction } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } };
const OPENAI_DEV = {
	agentId: "cline" as const,
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
};

function createVerdict(overrides: Partial<QaVerdict> = {}): QaVerdict {
	return {
		verdict: "PASS",
		scores: { spec: 5, correctness: 4, tests: 4, ux: null, code: 4, process: 5 },
		blocking: [],
		visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
		notes: "looks right",
		log: "- no blocking issues",
		...overrides,
	};
}

type Columns = Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>;

function createdTasks(actions: QaGateHarnessAction[]) {
	return actions.flatMap((action) => (action.kind === "createTask" ? [action.task] : []));
}

const REWORK_KINDS = new Set(["updateTask", "resumeTask", "blockTask"]);

/** The QA gate's own actions; what the rework stage does after a FAIL is tested in rework.test.ts. */
function kinds(actions: QaGateHarnessAction[]) {
	return actions
		.filter(
			(action) =>
				!REWORK_KINDS.has(action.kind) && !(action.kind === "deliverInput" && !action.taskId.startsWith("qa")),
		)
		.map(
			(action) =>
				`${action.kind}:${"taskId" in action ? action.taskId : "task" in action ? action.task.taskId : ""}`,
		);
}

describe("QA gate", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	const createHarness = (...args: Parameters<typeof createPipelineWorkerHarness>) => {
		const harness = createPipelineWorkerHarness(...args);
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	const send = async (
		harness: ReturnType<typeof createPipelineWorkerHarness>,
		columns: Columns,
		options: {
			workspaceId?: string;
			sessions?: Parameters<typeof createSnapshot>[0]["sessions"];
			pidPressure?: boolean;
		} = {},
	) => {
		await harness.send({
			...createSnapshot({
				workspaceId: options.workspaceId ?? "foo",
				board: createBoard(columns),
				selectedAgentId: "claude",
				sessions: options.sessions,
			}),
			...(options.pidPressure ? { pidPressure: true } : {}),
		});
	};

	it("creates one QA card per snapshot with role qa, reviewsTaskId and the kit's QA agent and model", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const dev = createCard({ id: "d1111", ...OPENAI_DEV });

		await send(harness, { review: [dev] });
		await send(harness, { review: [dev] });

		const tasks = createdTasks(harness.actions);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({
			taskId: "qa001",
			title: "QA d1111: Task d1111",
			role: "qa",
			reviewsTaskId: "d1111",
			// team routes OpenAI-built cards to Haiku on Cline.
			agentId: "cline",
			agentSettings: { providerId: "bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
			baseRef: "main",
		});
		expect(tasks[0]?.prompt).toContain("You are the QA reviewer (round 1) for Kanban dev card d1111");
		expect(tasks[0]?.prompt).toContain("OUT=/tmp/kanban-qa-out/qa001");
		expect(tasks[0]?.prompt).toContain("DRIVE THE CHANGED PATH");
		const state = await harness.store.load("foo");
		expect(state.cards.d1111).toMatchObject({ qaCreated: "snap-d1111", qaCard: "qa001" });
		expect(readQaGateEntry(state.cards.qa001)).toMatchObject({ status: "queued", round: 1, reviewsTaskId: "d1111" });
		expect(harness.readCardDecisions("foo").filter((record) => record.stage === "qa_gate")).toMatchObject([
			{ taskId: "d1111", outcome: "acted", note: expect.stringContaining("QA card qa001 was created for snapshot") },
			{ taskId: "d1111", outcome: "none", note: expect.stringContaining("already has QA card qa001") },
		]);
	});

	it("creates nothing in shadow, without a snapshot, for an empty snapshot, or while the session runs", async () => {
		const shadow = createHarness({
			config: { workspaces: { foo: { ...QA_WORKSPACE, pipeline: { shadow: true } } } },
		});
		await send(shadow, { review: [createCard({ id: "d1111" })] });
		expect(shadow.actions).toEqual([]);
		expect(shadow.previewCalls).toEqual([]);
		expect(shadow.readCardDecisions("foo")).toMatchObject([{ outcome: "shadow" }]);

		const noSnapshot = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			// The submission stage drops a card with an empty snapshot before the kit is asked (P4-2).
			snapshot: () => null,
		});
		await send(noSnapshot, { review: [createCard({ id: "d1111" })] });
		await send(
			noSnapshot,
			{ review: [createCard({ id: "live" })] },
			{ sessions: [{ taskId: "live", state: "running" }] },
		);
		expect(createdTasks(noSnapshot.actions)).toEqual([]);
		const notes = noSnapshot.readCardDecisions("foo").map((record) => [record.taskId, record.outcome, record.note]);
		expect(notes).toEqual([
			["d1111", "none", expect.stringContaining("no snapshot yet (refs/kanban/snapshots/d1111)")],
			["live", "none", expect.stringContaining("the session is still running")],
		]);
	});

	it("snapshots and queues QA only once the Review has settled: not in a flicker, not before the 6 s late turn", async () => {
		const inspected: number[] = [];
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			inspectSubmission: async () => {
				inspected.push(now);
				return { hasWork: true, records: [] };
			},
		});
		let now = T0;
		const dev = createCard({ id: "d1111", ...OPENAI_DEV });
		const sendAt = async (at: number, state: "awaiting_review" | "running", stateChangedAt: number) => {
			now = at;
			harness.setNow(at);
			await send(harness, { review: [dev] }, { sessions: [{ taskId: "d1111", state, stateChangedAt }] });
		};

		// An autopilot continuation: agentStop, then its own continue prompt 100 ms later.
		await sendAt(T0 + 50, "awaiting_review", T0);
		await sendAt(T0 + 150, "running", T0 + 100);
		// The final agentStop, then a background shell starts a new turn 6 s later.
		await sendAt(T0 + 11_000, "awaiting_review", T0 + 6_000);
		await sendAt(T0 + 12_100, "running", T0 + 12_000);
		// That turn ends; until it has been in Review for the settle period (12 s), nothing is snapshotted.
		await sendAt(T0 + 31_999, "awaiting_review", T0 + 20_000);
		expect(inspected).toEqual([]);
		expect(createdTasks(harness.actions)).toEqual([]);
		expect(harness.readCardDecisions("foo").map((record) => record.note)).toEqual([
			"the turn ended moments ago; QA waits for the Review to settle",
			"the session is still running; QA waits for the turn to end",
			"the turn ended moments ago; QA waits for the Review to settle",
			"the session is still running; QA waits for the turn to end",
			"the turn ended moments ago; QA waits for the Review to settle",
		]);

		await sendAt(T0 + 32_000, "awaiting_review", T0 + 20_000);
		expect(inspected).toEqual([T0 + 32_000]);
		expect(createdTasks(harness.actions)).toMatchObject([{ taskId: "qa001", reviewsTaskId: "d1111" }]);
	});

	it("uses the server's settle period from the snapshot, and a summary without stateChangedAt is settled", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const board = createBoard({ review: [createCard({ id: "d1111", ...OPENAI_DEV })] });
		const snapshot = (reviewSettleMs: number) => ({
			...createSnapshot({
				workspaceId: "foo",
				board,
				selectedAgentId: "claude",
				sessions: [{ taskId: "d1111", state: "awaiting_review", stateChangedAt: T0 - 5_000 }],
			}),
			reviewSettleMs,
		});
		await harness.send(snapshot(10_000));
		expect(createdTasks(harness.actions)).toEqual([]);
		await harness.send(snapshot(5_000));
		expect(createdTasks(harness.actions)).toHaveLength(1);

		const legacy = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await send(legacy, { review: [createCard({ id: "d2222", ...OPENAI_DEV })] }, { sessions: [{ taskId: "d2222" }] });
		expect(createdTasks(legacy.actions)).toHaveLength(1);
	});

	it("leaves a dev card alone while another QA card reviews it, including a legacy one without a role", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const legacyQa = createCard({
			id: "q9999",
			title: "QA2 d1111: Wishlist",
			prompt: 'You are the QA reviewer (round 2) for Kanban dev card d1111 ("Wishlist"), built by a junior agent.',
		});

		await send(harness, { review: [createCard({ id: "d1111" })], in_progress: [legacyQa] });

		expect(harness.actions).toEqual([]);
		expect(harness.readCardDecisions("foo").find((record) => record.taskId === "d1111")?.note).toContain(
			"QA card q9999 (in_progress) already reviews this card",
		);
	});

	it("starts queued QA cards oldest first within the machine-wide slots, and parks one whose dev card is back In Progress", async () => {
		const harness = createHarness({
			config: { pipeline: { qa: { slots: 1 } }, workspaces: { foo: QA_WORKSPACE, bar: QA_WORKSPACE } },
		});
		await send(harness, { review: [createCard({ id: "d1111" }), createCard({ id: "d2222" })] });
		expect(createdTasks(harness.actions).map((task) => task.taskId)).toEqual(["qa001", "qa002"]);

		// The board now shows both QA cards in Backlog; d1111 went back to In Progress (a rework while QA waited).
		harness.actions.length = 0;
		const qa1 = createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" });
		const qa2 = createCard({ id: "qa002", role: "qa", reviewsTaskId: "d2222" });
		await send(harness, {
			backlog: [qa1, qa2],
			in_progress: [createCard({ id: "d1111" })],
			review: [createCard({ id: "d2222" })],
		});
		expect(kinds(harness.actions)).toEqual(["startTask:qa002"]);

		// qa002 runs and holds the only slot, so neither qa001 nor a QA card on another workspace starts.
		harness.actions.length = 0;
		await send(harness, {
			backlog: [qa1],
			in_progress: [qa2],
			review: [createCard({ id: "d1111" }), createCard({ id: "d2222" })],
		});
		await send(harness, { review: [createCard({ id: "b1111" })] }, { workspaceId: "bar" });
		await send(
			harness,
			{
				backlog: [createCard({ id: "qa003", role: "qa", reviewsTaskId: "b1111" })],
				review: [createCard({ id: "b1111" })],
			},
			{ workspaceId: "bar" },
		);
		expect(kinds(harness.actions)).toEqual(["createTask:qa003"]);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa002)).toMatchObject({
			status: "running",
			startedAt: T0,
		});
	});

	it("creates and starts no QA card under PID pressure, logs each hold once, and goes on when it clears", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const dev = createCard({ id: "d1111" });

		await send(harness, { review: [dev] }, { pidPressure: true });
		await send(harness, { review: [dev] }, { pidPressure: true });
		expect(createdTasks(harness.actions)).toEqual([]);
		expect(harness.readCardDecisions("foo").map((record) => [record.outcome, record.note])).toEqual([
			["none", expect.stringContaining("PID pressure: no QA card for snapshot snap-d11 until it clears")],
		]);

		await send(harness, { review: [dev] });
		expect(kinds(harness.actions)).toEqual(["createTask:qa001"]);
		expect(harness.readCardDecisions("foo").at(-1)).toMatchObject({ taskId: "d1111", outcome: "acted" });

		// The queued QA card waits in Backlog while pressure lasts: one record for the hold, no start.
		harness.actions.length = 0;
		const qa = createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" });
		await send(harness, { backlog: [qa], review: [dev] }, { pidPressure: true });
		await send(harness, { backlog: [qa], review: [dev] }, { pidPressure: true });
		expect(harness.actions).toEqual([]);
		const holds = () =>
			harness
				.readDecisions("foo")
				.filter((record) => record.stage === "qa_start")
				.map((record) => [record.taskId, record.outcome, record.note]);
		expect(holds()).toEqual([[null, "none", "PID pressure: holding 1 queued QA card(s) (qa001) until it clears"]]);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)).toMatchObject({ status: "queued" });

		await send(harness, { backlog: [qa], review: [dev] });
		expect(kinds(harness.actions)).toEqual(["startTask:qa001"]);
		expect(holds()).toHaveLength(2);
		expect(holds()[1]).toEqual(["qa001", "acted", expect.stringContaining("started QA of d1111 round 1")]);
	});

	it("starts no QA card on a provider at its capacity while In Progress cards hold another model there", async () => {
		const harness = createHarness({
			config: {
				workspaces: {
					foo: { landing: { mode: "qa" }, kit: { name: "team-local" }, models: { allowProvisional: true } },
				},
			},
		});
		const onGlm = {
			agentId: "cline" as const,
			agentSettings: { providerId: "lemonade", modelId: "GLM-4.7-Flash-GGUF" },
		};
		const dev = createCard({ id: "d1111", ...onGlm });
		const busy = createCard({ id: "d2222", ...onGlm });
		await send(harness, { review: [dev], in_progress: [busy] });
		expect(createdTasks(harness.actions)).toMatchObject([
			{ taskId: "qa001", agentSettings: { providerId: "lemonade", modelId: "Devstral-Small-2507-GGUF" } },
		]);

		// Lemonade loads one model: Devstral would evict GLM while d2222 still runs on it. One record per hold.
		harness.actions.length = 0;
		const qa = createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111", ...onGlm });
		const qaOnDevstral = { ...qa, agentSettings: { providerId: "lemonade", modelId: "Devstral-Small-2507-GGUF" } };
		await send(harness, { backlog: [qaOnDevstral], in_progress: [busy], review: [dev] });
		await send(harness, { backlog: [qaOnDevstral], in_progress: [busy], review: [dev] });
		expect(harness.actions).toEqual([]);
		const starts = () =>
			harness
				.readDecisions("foo")
				.filter((record) => record.stage === "qa_start")
				.map((record) => [record.taskId, record.outcome, record.note]);
		expect(starts()).toEqual([
			["qa001", "none", "waiting for provider lemonade (max 1 loaded model(s)): held by d2222 (GLM-4.7-Flash-GGUF)"],
		]);

		// d2222 finished (it gets a QA card of its own): GLM is free, so Devstral may load.
		await send(harness, { backlog: [qaOnDevstral], review: [dev, busy] });
		expect(kinds(harness.actions)).toEqual(["createTask:qa002", "startTask:qa001"]);
	});

	it("frees the slot of a QA card that runs past timeoutMin", async () => {
		const harness = createHarness({
			config: { pipeline: { qa: { slots: 1, timeoutMin: 60 } }, workspaces: { foo: QA_WORKSPACE } },
		});
		await send(harness, { review: [createCard({ id: "d1111" }), createCard({ id: "d2222" })] });
		const qa1 = createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" });
		const qa2 = createCard({ id: "qa002", role: "qa", reviewsTaskId: "d2222" });
		const review = [createCard({ id: "d1111" }), createCard({ id: "d2222" })];
		await send(harness, { backlog: [qa1, qa2], review });
		harness.actions.length = 0;

		harness.setNow(T0 + 61 * 60_000);
		await send(harness, { backlog: [qa2], in_progress: [qa1], review });

		expect(kinds(harness.actions)).toEqual(["startTask:qa002"]);
		expect(
			harness.readCardDecisions("foo", "qa_start").some((record) => record.note.includes("its QA slot is freed")),
		).toBe(true);
	});

	it("starts the kit's preview before a QA card and reports QA idle afterwards", async () => {
		const preview = { pidFile: ".preview.pid", start: "npm run preview:start", stop: "npm run preview:stop" };
		const harness = createHarness({
			config: {
				workspaces: { foo: { ...QA_WORKSPACE, kit: { name: "team", overrides: { "qa.preview": preview } } } },
			},
		});
		await send(harness, { review: [createCard({ id: "d1111" })] });
		await send(harness, {
			backlog: [createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" })],
			review: [createCard({ id: "d1111" })],
		});

		expect(harness.previewCalls.filter((call) => call.call === "ensure")).toEqual([
			{ call: "ensure", workspaceId: "foo" },
		]);
		expect(harness.previewCalls.at(-1)).toEqual({ call: "stopIfIdle", workspaceId: "foo", qaActive: true });
	});

	const startQa = async (harness: ReturnType<typeof createPipelineWorkerHarness>) => {
		await send(harness, { review: [createCard({ id: "d1111", ...OPENAI_DEV })] });
		await send(harness, {
			backlog: [createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" })],
			review: [createCard({ id: "d1111", ...OPENAI_DEV })],
		});
		harness.actions.length = 0;
	};
	const qaInReview = {
		review: [
			createCard({ id: "d1111", ...OPENAI_DEV }),
			createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" }),
		],
	};

	it("ingests a verdict: QA log, dev-card state, verdictRecorded, scratch servers stopped, QA card to Done", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", {
			kind: "ok",
			verdict: createVerdict({
				verdict: "FAIL",
				blocking: ["the cart count does not change"],
				log: "- cart broken",
			}),
		});

		await send(harness, qaInReview);
		await send(harness, qaInReview);

		expect(kinds(harness.actions)).toEqual(["finishTask:qa001"]);
		const log = readFileSync(harness.qaLogPath("foo"), "utf8");
		expect(log).toContain("## Claude QA d1111: FAIL (2026-10-07 10:00 UTC)\n- cart broken");
		expect(log).toContain("- Reviewer: cline on bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0, QA card qa001");
		const state = await harness.store.load("foo");
		expect(readQaVerdictRecords(state.cards.d1111)).toMatchObject([
			{
				qaTaskId: "qa001",
				round: 1,
				snapshot: "snap-d1111",
				verdict: "FAIL",
				blocking: ["the cart count does not change"],
			},
		]);
		expect(readQaGateEntry(state.cards.qa001)).toMatchObject({ status: "ingested", verdict: "FAIL", trashed: true });
		expect(harness.events.filter((event) => event.name === "verdictRecorded")).toMatchObject([
			{
				name: "verdictRecorded",
				event: {
					workspaceId: "foo",
					taskId: "d1111",
					qaTaskId: "qa001",
					verdict: { verdict: "FAIL", round: 1 },
					devAgentId: "cline",
					devModel: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
					qaAgentId: "cline",
				},
			},
		]);
		expect(harness.stoppedScratch).toEqual([["/tmp/kanban-qa/d1111", "/tmp/kanban-qa/d1111-main"]]);
	});

	it("records a PASS with visual QA blocked as STALLED", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", {
			kind: "ok",
			verdict: createVerdict({ visual: { status: "blocked", artifacts: [], consoleErrors: 0 } }),
		});

		await send(harness, qaInReview);

		const [record] = readQaVerdictRecords((await harness.store.load("foo")).cards.d1111);
		expect(record?.verdict).toBe("STALLED");
		expect(readFileSync(harness.qaLogPath("foo"), "utf8")).toContain(
			"PASS with visual blocked → recorded as STALLED",
		);
	});

	it("lands a PASS once through the Done workflow, after the QA card is Done", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict() });

		await send(harness, qaInReview);
		await send(harness, qaInReview);

		expect(harness.actions).toEqual([
			{ kind: "finishTask", workspaceId: "foo", taskId: "qa001", landing: "discard", trigger: "pipeline" },
			{ kind: "finishTask", workspaceId: "foo", taskId: "d1111", landing: "land", trigger: "pipeline" },
		]);
		expect((await harness.store.load("foo")).cards.d1111?.qaPass).toMatchObject({
			qaTaskId: "qa001",
			snapshot: "snap-d1111",
			action: "land",
			status: "trashed",
		});
		expect(harness.readCardDecisions("foo", "qa_pass")).toMatchObject([
			{ taskId: "d1111", outcome: "acted", note: "PASS of round 1: landed and Done (trashed)" },
		]);
	});

	it("never QAs or lands an escalated card back in Review without a handback (a sibling may have its task)", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await harness.store.update("foo", (state) => {
			state.cards.d1111 = { qaflow: { escalated: { at: "2026-10-07T09:00:00.000Z", reason: "tier 2" } } };
			return state;
		});
		await send(harness, { review: [createCard({ id: "d1111", ...OPENAI_DEV })] });
		expect(createdTasks(harness.actions)).toEqual([]);
		expect(harness.readCardDecisions("foo")[0]?.note).toContain(
			"escalated 2026-10-07T09:00:00.000Z: not QA'd or landed",
		);

		// Escalated after its QA card was made: its PASS is recorded but never landed.
		const passed = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(passed);
		passed.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict() });
		await passed.store.update("foo", (state) => {
			state.cards.d1111 = { ...state.cards.d1111, qaflow: { escalated: { at: "2026-10-07T09:00:00.000Z" } } };
			return state;
		});
		await send(passed, qaInReview);
		await send(passed, qaInReview);
		expect(kinds(passed.actions)).toEqual(["finishTask:qa001"]);
	});

	it("records a failed land (a conflict) once and leaves the card in Review for the rework stage", async () => {
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			actionResult: (action) =>
				action.kind === "finishTask" && action.taskId === "d1111"
					? { ok: false, error: "conflicts in src/cart.ts" }
					: { ok: true },
		});
		await startQa(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict() });

		await send(harness, qaInReview);
		await send(harness, { review: [createCard({ id: "d1111", ...OPENAI_DEV })] });

		expect(kinds(harness.actions)).toEqual(["finishTask:qa001", "finishTask:d1111"]);
		expect(harness.readCardDecisions("foo", "qa_pass")[0]?.note).toContain(
			"landing failed (failed: conflicts in src/cart.ts); left in Review",
		);
	});

	it("does not land a PASS while the dev card's session runs, nor one for an older snapshot", async () => {
		let snapshot = "snap-d1111";
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			snapshot: (taskId) => (taskId === "d1111" ? snapshot : `snap-${taskId}`),
		});
		await startQa(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict() });

		await send(harness, qaInReview, { sessions: [{ taskId: "d1111", state: "running" }] });
		expect(kinds(harness.actions)).toEqual(["finishTask:qa001"]);

		// The card was reworked after QA: its snapshot moved on, and the new one gets its own QA card.
		snapshot = "snap-d1111-v2";
		await send(harness, { review: [createCard({ id: "d1111", ...OPENAI_DEV })] });
		expect(kinds(harness.actions)).toEqual(["finishTask:qa001", "createTask:qa002"]);
		expect(harness.readCardDecisions("foo", "qa_pass")[0]?.note).toContain(
			"was for snapshot snap-d11; the card changed since (snap-d11)",
		);
	});

	it("waits verdictGraceSec, nudges with the reason up to maxNudges, then records STALLED", async () => {
		const harness = createHarness({
			config: { pipeline: { qa: { maxNudges: 1, verdictGraceSec: 20 } }, workspaces: { foo: QA_WORKSPACE } },
		});
		await startQa(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "invalid", error: "invalid JSON (Unexpected token)" });

		await send(harness, qaInReview);
		expect(harness.actions).toEqual([]);

		harness.setNow(T0 + 21_000);
		await send(harness, qaInReview);
		expect(harness.actions).toMatchObject([{ kind: "deliverInput", taskId: "qa001" }]);
		const nudge = harness.actions[0];
		expect(nudge?.kind === "deliverInput" ? nudge.text : "").toContain(
			"/tmp/kanban-qa-out/qa001/verdict.json exists but is not usable: invalid JSON (Unexpected token)",
		);

		// The QA agent stops again without fixing it: the grace runs again, then STALLED.
		harness.actions.length = 0;
		harness.setNow(T0 + 30_000);
		await send(harness, qaInReview);
		harness.setNow(T0 + 51_000);
		await send(harness, qaInReview);
		// The team kit's qaStalled trigger hands the dev card to its fallback role at once (a sibling, no approval).
		expect(kinds(harness.actions)).toEqual(["finishTask:qa001", "createTask:s0001", "startTask:s0001"]);
		const [record] = readQaVerdictRecords((await harness.store.load("foo")).cards.d1111);
		expect(record).toMatchObject({ verdict: "STALLED", notes: expect.stringContaining("unusable verdict.json") });
	});

	describe("a QA card whose own agent failed (issue #12)", () => {
		const IMAGE_ERROR = {
			kind: "image_rejected" as const,
			tooLarge: true,
			text: "messages.1.content.86.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels",
		};
		const config = {
			pipeline: { qa: { maxNudges: 2, verdictGraceSec: 20 } },
			workspaces: { foo: QA_WORKSPACE },
		};
		const dev = () => createCard({ id: "d1111", ...OPENAI_DEV });
		const qaCard = (id: string) => createCard({ id, role: "qa", reviewsTaskId: "d1111" });

		/** The QA card ends in Review with no verdict: seen once, then once more after the grace. */
		const endInReview = async (harness: ReturnType<typeof createHarness>, qaTaskId: string, at: number) => {
			harness.setNow(at);
			await send(harness, { review: [dev(), qaCard(qaTaskId)] });
			harness.setNow(at + 21_000);
			await send(harness, { review: [dev(), qaCard(qaTaskId)] });
		};
		/** The superseded QA card is in Done: the dev card's next Review queues its replacement, then it starts. */
		const replace = async (harness: ReturnType<typeof createHarness>, oldId: string, newId: string) => {
			await send(harness, { review: [dev()], trash: [qaCard(oldId)] });
			await send(harness, { backlog: [qaCard(newId)], review: [dev()], trash: [qaCard(oldId)] });
		};

		it("is not nudged but replaced for the same snapshot, then STALLED for the orchestrator, never a takeover", async () => {
			const harness = createHarness({ config });
			await startQa(harness);
			harness.setRunError("qa001", IMAGE_ERROR);

			await endInReview(harness, "qa001", T0 + 60_000);
			// No nudge: it would resend the conversation whose image fails every request.
			expect(harness.actions.filter((action) => action.kind === "deliverInput")).toEqual([]);
			expect(kinds(harness.actions)).toEqual(["finishTask:qa001"]);
			let state = await harness.store.load("foo");
			expect(readQaGateEntry(state.cards.qa001)).toMatchObject({ status: "superseded", trashed: true });
			expect(readQaVerdictRecords(state.cards.d1111)).toEqual([]);
			expect(state.cards.d1111?.qaCreated).toBeUndefined();
			expect(harness.readCardDecisions("foo", "qa_ingest").at(-1)?.note).toContain(
				"the QA agent's own run failed (image over the model's size limits",
			);

			await replace(harness, "qa001", "qa002");
			const [replacement] = createdTasks(harness.actions);
			expect(replacement).toMatchObject({ taskId: "qa002", reviewsTaskId: "d1111" });
			// Same round, same snapshot; the legacy prompt with the note after it.
			expect(replacement?.prompt).toContain("You are the QA reviewer (round 1) for Kanban dev card d1111");
			expect(replacement?.prompt).toMatch(
				/NOTE \(Kanban\): an earlier QA card for this snapshot ended on its own error/u,
			);
			expect(replacement?.prompt).toContain("Never open a full-page screenshot");
			expect(readQaGateEntry((await harness.store.load("foo")).cards.qa002)).toMatchObject({
				snapshot: "snap-d1111",
				round: 1,
			});

			harness.setRunError("qa002", IMAGE_ERROR);
			await endInReview(harness, "qa002", T0 + 5 * 60_000);
			await replace(harness, "qa002", "qa003");
			harness.setRunError("qa003", IMAGE_ERROR);
			harness.actions.length = 0;
			await endInReview(harness, "qa003", T0 + 10 * 60_000);

			state = await harness.store.load("foo");
			const [record] = readQaVerdictRecords(state.cards.d1111);
			expect(record).toMatchObject({
				qaTaskId: "qa003",
				verdict: "STALLED",
				qaAgentError: expect.stringContaining("image over the model's size limits"),
			});
			// The rework stage hands it to the orchestrator: the dev card is blocked, no sibling takes it over.
			const escalated = (state.cards.d1111?.qaflow as Record<string, unknown> | undefined)?.escalated;
			expect(escalated).toMatchObject({ to: "orchestrator", cause: "qa_agent_error" });
			expect(createdTasks(harness.actions)).toEqual([]);
			expect(harness.actions.filter((action) => action.kind === "deliverInput")).toEqual([]);
			expect(kinds(harness.actions)).toEqual(["finishTask:qa003"]);
			expect(harness.actions.some((action) => action.kind === "blockTask" && action.taskId === "d1111")).toBe(true);
		});

		it("still nudges a QA card that just stopped without a verdict", async () => {
			const harness = createHarness({ config });
			await startQa(harness);
			await endInReview(harness, "qa001", T0 + 60_000);
			expect(harness.actions).toMatchObject([{ kind: "deliverInput", taskId: "qa001" }]);
		});

		it("takes an agent error from the session summary too", async () => {
			const harness = createHarness({ config });
			await startQa(harness);
			const sessions = [
				{
					taskId: "qa001",
					state: "awaiting_review" as const,
					reviewReason: "error" as const,
					stateChangedAt: T0,
					live: true,
				},
			];
			harness.setNow(T0 + 60_000);
			await send(harness, { review: [dev(), qaCard("qa001")] }, { sessions });
			harness.setNow(T0 + 90_000);
			await send(harness, { review: [dev(), qaCard("qa001")] }, { sessions });
			expect(kinds(harness.actions)).toEqual(["finishTask:qa001"]);
			expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)).toMatchObject({ status: "superseded" });
		});
	});

	it("a QA card moved to Done without a verdict does not block QA: it is superseded and the snapshot gets a new one", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(harness);

		await send(harness, {
			review: [createCard({ id: "d1111", ...OPENAI_DEV })],
			trash: [createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" })],
		});

		expect(kinds(harness.actions)).toEqual(["createTask:qa002", "finishTask:qa001"]);
		const state = await harness.store.load("foo");
		expect(readQaGateEntry(state.cards.qa001)).toMatchObject({ status: "superseded", supersededAt: T0 });
		expect(readQaGateEntry(state.cards.qa002)).toMatchObject({ status: "queued", snapshot: "snap-d1111", round: 1 });
		expect(state.cards.d1111).toMatchObject({ qaCreated: "snap-d1111", qaCard: "qa002" });
		expect(harness.readCardDecisions("foo").at(-1)?.note).toContain(
			"QA card qa001 of round 1 for snapshot snap-d11 went to Done before its verdict was ingested: superseded",
		);
	});

	it("after a restart, a QA card settled in Review still gets ingested, and one this server started is not dead", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(harness);
		harness.setNow(T0 + 10 * 60_000);
		const restarted = {
			...createSnapshot({
				workspaceId: "foo",
				board: createBoard(qaInReview),
				selectedAgentId: "claude",
				sessions: [{ taskId: "qa001", state: "awaiting_review", startedAt: T0, stateChangedAt: T0, live: false }],
			}),
			serverStartedAt: T0 + 5 * 60_000,
		};
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict({ verdict: "FAIL" }) });
		await harness.send(restarted);
		expect(kinds(harness.actions)).toEqual(["finishTask:qa001"]);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)).toMatchObject({ status: "ingested" });

		// Started under this server, In Progress with no summary yet (the snapshot predates the session): still alive.
		const fresh = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(fresh);
		await fresh.send({
			...createSnapshot({
				workspaceId: "foo",
				board: createBoard({
					in_progress: [createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" })],
					review: [createCard({ id: "d1111", ...OPENAI_DEV })],
				}),
				selectedAgentId: "claude",
			}),
			serverStartedAt: T0 - 60_000,
		});
		expect(fresh.actions).toEqual([]);
		expect(readQaGateEntry((await fresh.store.load("foo")).cards.qa001)).toMatchObject({ status: "running" });
	});

	for (const state of ["interrupted", "idle"] as const) {
		it(`after a restart, a Review QA card whose ${state} session died with the old server is ingested once from its verdict, with no second QA card`, async () => {
			const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
			await startQa(harness);
			harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict() });
			harness.setNow(T0 + 10 * 60_000);
			const restarted = {
				...createSnapshot({
					workspaceId: "foo",
					board: createBoard(qaInReview),
					selectedAgentId: "claude",
					sessions: [{ taskId: "qa001", state, startedAt: T0, stateChangedAt: T0, live: false }],
				}),
				serverStartedAt: T0 + 5 * 60_000,
			};

			await harness.send(restarted);
			await harness.send(restarted);

			// startQa cleared the actions: no second QA card.
			expect(createdTasks(harness.actions)).toEqual([]);
			const stored = await harness.store.load("foo");
			expect(readQaVerdictRecords(stored.cards.d1111)).toMatchObject([{ qaTaskId: "qa001", verdict: "PASS" }]);
			expect(readQaGateEntry(stored.cards.qa001)).toMatchObject({ status: "ingested", trashed: true });
			expect(harness.events.filter((event) => event.name === "verdictRecorded")).toHaveLength(1);
			expect(kinds(harness.actions).filter((kind) => kind.startsWith("finishTask"))).toEqual([
				"finishTask:qa001",
				"finishTask:d1111",
			]);
		});
	}

	it("never ingests a superseded QA card, even one still in Review", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		await startQa(harness);
		harness.setNow(T0 + 10 * 60_000);
		const restarted = {
			...createSnapshot({
				workspaceId: "foo",
				board: createBoard(qaInReview),
				selectedAgentId: "claude",
				sessions: [{ taskId: "qa001", state: "interrupted", startedAt: T0, stateChangedAt: T0, live: false }],
			}),
			serverStartedAt: T0 + 5 * 60_000,
		};
		// No verdict yet: superseded, and a new QA card queued.
		await harness.send(restarted);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)).toMatchObject({ status: "superseded" });
		// A verdict.json appearing later (the old QA run) is never read.
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict() });
		await harness.send(restarted);
		expect(readQaVerdictRecords((await harness.store.load("foo")).cards.d1111)).toEqual([]);
		expect(createdTasks(harness.actions).map((task) => task.taskId)).toEqual(["qa002"]);
		expect(harness.actions.filter((action) => action.kind === "deliverInput")).toEqual([]);
	});

	it("does not ingest a QA card it did not create (the legacy kit's)", async () => {
		const harness = createHarness({ config: { workspaces: { foo: QA_WORKSPACE } } });
		const legacyQa = createCard({
			id: "q9999",
			title: "QA d1111: Wishlist",
			prompt: 'You are the QA reviewer (round 1) for Kanban dev card d1111 ("Wishlist")',
		});

		await send(harness, { review: [legacyQa] });

		expect(harness.actions).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	it("retries the Done move of an ingested QA card without recording the verdict again", async () => {
		let failTrash = true;
		const harness = createHarness({
			config: { workspaces: { foo: QA_WORKSPACE } },
			actionResult: (action) =>
				action.kind === "finishTask" && failTrash ? { ok: false, error: "board busy" } : { ok: true },
		});
		await startQa(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict({ verdict: "FAIL" }) });

		await send(harness, qaInReview);
		failTrash = false;
		await send(harness, qaInReview);

		expect(kinds(harness.actions)).toEqual(["finishTask:qa001", "finishTask:qa001"]);
		expect(readQaVerdictRecords((await harness.store.load("foo")).cards.d1111)).toHaveLength(1);
		expect(harness.events.filter((event) => event.name === "verdictRecorded")).toHaveLength(1);
	});
});
