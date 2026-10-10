import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import { readQaGateEntry, readQaVerdictRecords } from "../../../src/pipeline/qa-gate";
import type { QaVerdict } from "../../../src/pipeline/qa-verdict";
import { createPipelineWorkerHarness, createSnapshot, type QaGateHarnessAction } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

// A paused workspace (`workspaces.<id>.pipeline.paused`, `kanban pipeline pause`, issue #23): QA cards are created and
// queued, none starts, no QA card is nudged, no PASS lands and no rework is sent; the resume lets all of it act.
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const PAUSED_AT = "2026-10-07T09:30:00.000Z";
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } };
const PAUSED_WORKSPACE = { ...QA_WORKSPACE, pipeline: { paused: true, pausedAt: PAUSED_AT } };
const OPENAI_DEV = {
	agentId: "cline" as const,
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
};

type Columns = Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>;

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

function kinds(actions: QaGateHarnessAction[]): string[] {
	return actions.map(
		(action) => `${action.kind}:${"taskId" in action ? action.taskId : "task" in action ? action.task.taskId : ""}`,
	);
}

describe("QA gate on a paused workspace", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	const createHarness = (config: unknown) => {
		const harness = createPipelineWorkerHarness({ config });
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	const send = async (harness: ReturnType<typeof createPipelineWorkerHarness>, columns: Columns) => {
		await harness.send(
			createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId: "claude" }),
		);
	};
	const dev = () => createCard({ id: "d1111", ...OPENAI_DEV });
	const qa = () => createCard({ id: "qa001", role: "qa", reviewsTaskId: "d1111" });
	const configWith = (foo: unknown, pipeline: unknown = {}) => ({ pipeline, workspaces: { foo } });

	/** A QA card created and started before the pause, now in Review with its turn over. */
	const startQaThenPause = async (
		harness: ReturnType<typeof createPipelineWorkerHarness>,
		pipeline: unknown = {},
	): Promise<void> => {
		await send(harness, { review: [dev()] });
		await send(harness, { backlog: [qa()], review: [dev()] });
		expect(kinds(harness.actions)).toEqual(["createTask:qa001", "startTask:qa001"]);
		harness.actions.length = 0;
		harness.setConfig(configWith(PAUSED_WORKSPACE, pipeline));
	};

	it("creates the QA card but starts none, records the hold once, and starts it on the resume", async () => {
		const harness = createHarness(configWith(PAUSED_WORKSPACE));

		await send(harness, { review: [dev()] });
		expect(kinds(harness.actions)).toEqual(["createTask:qa001"]);
		await send(harness, { backlog: [qa()], review: [dev()] });
		await send(harness, { backlog: [qa()], review: [dev()] });
		expect(kinds(harness.actions)).toEqual(["createTask:qa001"]);
		expect(readQaGateEntry((await harness.store.load("foo")).cards.qa001)).toMatchObject({ status: "queued" });
		const starts = () =>
			harness
				.readDecisions("foo")
				.filter((record) => record.stage === "qa_start")
				.map((record) => [record.taskId, record.outcome, record.note]);
		expect(starts()).toEqual([
			[
				null,
				"none",
				`QA pipeline paused since ${PAUSED_AT}: holding 1 queued QA card(s) (qa001) until \`kanban pipeline resume\``,
			],
		]);
		expect(harness.readDecisions("foo").find((record) => record.stage === "worker")?.note).toContain(", QA paused,");

		harness.setConfig(configWith(QA_WORKSPACE));
		await send(harness, { backlog: [qa()], review: [dev()] });
		expect(kinds(harness.actions)).toEqual(["createTask:qa001", "startTask:qa001"]);
		expect(starts().at(-1)).toEqual(["qa001", "acted", expect.stringContaining("started QA of d1111 round 1")]);
	});

	it("records a PASS a QA card wrote while paused, but lands it only after the resume", async () => {
		const harness = createHarness(configWith(QA_WORKSPACE));
		await startQaThenPause(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", { kind: "ok", verdict: createVerdict() });

		await send(harness, { review: [dev(), qa()] });
		await send(harness, { review: [dev()] });
		expect(kinds(harness.actions)).toEqual(["finishTask:qa001"]);
		expect(readQaVerdictRecords((await harness.store.load("foo")).cards.d1111).at(-1)?.verdict).toBe("PASS");

		harness.setConfig(configWith(QA_WORKSPACE));
		await send(harness, { review: [dev()] });
		expect(kinds(harness.actions)).toEqual(["finishTask:qa001", "finishTask:d1111"]);
	});

	it("doesn't nudge a QA card that stopped without a verdict while paused, and holds no cloud slot for it", async () => {
		const pipeline = { qa: { maxNudges: 1, verdictGraceSec: 20, slots: 1 } };
		const harness = createHarness(configWith(QA_WORKSPACE, pipeline));
		await startQaThenPause(harness, pipeline);

		await send(harness, { review: [dev(), qa()] });
		harness.setNow(T0 + 21_000);
		await send(harness, { review: [dev(), qa()] });
		expect(harness.actions).toEqual([]);

		// Another project's QA card takes the one cloud slot the paused project's finished QA card doesn't hold.
		harness.setConfig({ pipeline, workspaces: { foo: PAUSED_WORKSPACE, bar: QA_WORKSPACE } });
		await harness.send(
			createSnapshot({
				workspaceId: "bar",
				board: createBoard({ review: [createCard({ id: "b2222", ...OPENAI_DEV })] }),
				selectedAgentId: "claude",
			}),
		);
		await harness.send(
			createSnapshot({
				workspaceId: "bar",
				board: createBoard({
					backlog: [createCard({ id: "qa002", role: "qa", reviewsTaskId: "b2222" })],
					review: [createCard({ id: "b2222", ...OPENAI_DEV })],
				}),
				selectedAgentId: "claude",
			}),
		);
		expect(kinds(harness.actions)).toEqual(["createTask:qa002", "startTask:qa002"]);

		harness.actions.length = 0;
		harness.setConfig(configWith(QA_WORKSPACE, pipeline));
		await send(harness, { review: [dev(), qa()] });
		expect(harness.actions).toMatchObject([{ kind: "deliverInput", taskId: "qa001" }]);
	});

	it("sends no rework for a FAIL recorded while paused; the resume sends it", async () => {
		const harness = createHarness(configWith(QA_WORKSPACE));
		await startQaThenPause(harness);
		harness.setVerdict("/tmp/kanban-qa-out/qa001", {
			kind: "ok",
			verdict: createVerdict({ verdict: "FAIL", blocking: ["the cart count does not change"] }),
		});

		await send(harness, { review: [dev(), qa()] });
		await send(harness, { review: [dev()] });
		expect(kinds(harness.actions)).toEqual(["finishTask:qa001"]);

		harness.setConfig(configWith(QA_WORKSPACE));
		await send(harness, { review: [dev()] });
		expect(kinds(harness.actions).slice(1)).toContain("updateTask:d1111");
	});
});
