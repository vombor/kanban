// A QA card on LocalAI is local QA like Lemonade's: it takes no cloud QA slot and waits only for LocalAI's
// `models.providerCapacity`. The bundled registry vets no LocalAI model yet (they get vetted by the user's
// `kanban models vet` runs), so this suite's registry vets the two it routes to.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../../../src/core/api-contract";
import type * as VettedRegistryModule from "../../../src/models/vetted-registry";
import { createPipelineWorkerHarness, createSnapshot, type QaGateHarnessAction } from "../../utilities/pipeline-worker";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

vi.mock("../../../src/models/vetted-registry", async (importOriginal) => {
	const actual = await importOriginal<typeof VettedRegistryModule>();
	const vetted = { status: "vetted", at: "2026-10-11", cliVersion: null, evidence: { run: null, summary: "test" } };
	const registry = actual.vettedRegistrySchema.parse({
		registry: 1,
		entries: [
			...actual.getVettedRegistry().entries,
			...["gemma-4-26b-a4b-it", "qwen3-coder-next-q8-0-qwen"].map((model) => ({
				agent: "cline",
				provider: "localai",
				model,
				roles: Object.fromEntries(actual.VETTING_ROLES.map((role) => [role, vetted])),
			})),
		],
	});
	return { ...actual, getVettedRegistry: () => registry };
});

const OPENAI_DEV = {
	agentId: "cline" as const,
	agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
};
const ON_LOCALAI_QWEN = {
	agentId: "cline" as const,
	agentSettings: { providerId: "localai", modelId: "qwen3-coder-next-q8-0-qwen" },
};
const ON_LOCALAI_GEMMA = {
	agentId: "cline" as const,
	agentSettings: { providerId: "localai", modelId: "gemma-4-26b-a4b-it" },
};
const QA_WORKSPACE = { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } };
// team-local with its dev and QA models moved to LocalAI (the project settings a user would set with kit set).
const LOCALAI_WORKSPACE = {
	landing: { mode: "qa" },
	kit: {
		name: "team-local",
		overrides: {
			"roles.dev.provider": "localai",
			"roles.dev.model": "qwen3-coder-next-q8-0-qwen",
			"roles.qa.provider": "localai",
			"roles.qa.model": "gemma-4-26b-a4b-it",
		},
	},
	models: { allowProvisional: true },
};

type Columns = Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>;

function kinds(actions: QaGateHarnessAction[]) {
	return actions
		.filter((action) => action.kind === "createTask" || action.kind === "startTask")
		.map(
			(action) =>
				`${action.kind}:${"taskId" in action ? action.taskId : "task" in action ? action.task.taskId : ""}`,
		);
}

describe("QA gate: LocalAI QA cards", () => {
	const harnesses: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});
	const createHarness = (...args: Parameters<typeof createPipelineWorkerHarness>) => {
		const harness = createPipelineWorkerHarness(...args);
		harnesses.push(harness);
		return harness;
	};
	const send = async (harness: ReturnType<typeof createHarness>, columns: Columns, workspaceId = "foo") => {
		await harness.send(createSnapshot({ workspaceId, board: createBoard(columns), selectedAgentId: "claude" }));
	};
	const startNote = (harness: ReturnType<typeof createHarness>, workspaceId: string, taskId: string) =>
		harness.readCardDecisions(workspaceId, "qa_start").find((record) => record.taskId === taskId)?.note;
	const localQa = (id: string, devId: string) =>
		createCard({ id, role: "qa", reviewsTaskId: devId, ...ON_LOCALAI_GEMMA });
	const cloudQa = (id: string, devId: string) => createCard({ id, role: "qa", reviewsTaskId: devId });

	it("starts in LocalAI's capacity while a cloud QA card holds the only slot", async () => {
		const harness = createHarness({
			config: { pipeline: { qa: { slots: 1 } }, workspaces: { foo: QA_WORKSPACE, notes: LOCALAI_WORKSPACE } },
		});
		const d1 = createCard({ id: "d1111", ...OPENAI_DEV });
		const n1 = createCard({ id: "n1111", ...ON_LOCALAI_QWEN });

		// foo's Bedrock QA card takes the only cloud slot and keeps running.
		await send(harness, { review: [d1] });
		await send(harness, { backlog: [cloudQa("qa001", "d1111")], review: [d1] });
		await send(harness, { in_progress: [cloudQa("qa001", "d1111")], review: [d1] });
		expect(startNote(harness, "foo", "qa001")).toBe("started QA of d1111 round 1 (cloud slot 1/1)");

		// notes' LocalAI QA card starts all the same: it waits only for LocalAI's capacity (1 by default).
		harness.actions.length = 0;
		await send(harness, { review: [n1] }, "notes");
		const created = harness.actions.find((action) => action.kind === "createTask");
		expect(created?.kind === "createTask" ? created.task.agentSettings : null).toMatchObject({
			providerId: "localai",
			modelId: "gemma-4-26b-a4b-it",
		});
		await send(harness, { backlog: [localQa("qa002", "n1111")], review: [n1] }, "notes");
		expect(kinds(harness.actions)).toEqual(["createTask:qa002", "startTask:qa002"]);
		expect(startNote(harness, "notes", "qa002")).toBe(
			"started QA of n1111 round 1 (localai capacity, max 1 loaded model(s))",
		);
	});

	it("waits while a dev card of another project holds LocalAI's one model", async () => {
		const harness = createHarness({ config: { workspaces: { notes: LOCALAI_WORKSPACE, bar: LOCALAI_WORKSPACE } } });
		const b1 = createCard({ id: "b1111", ...ON_LOCALAI_QWEN });
		const n1 = createCard({ id: "n1111", ...ON_LOCALAI_QWEN });
		await send(harness, { in_progress: [b1] }, "bar");
		await send(harness, { review: [n1] }, "notes");
		await send(harness, { backlog: [localQa("qa001", "n1111")], review: [n1] }, "notes");
		expect(kinds(harness.actions)).toEqual(["createTask:qa001"]);
		expect(
			harness
				.readDecisions("notes")
				.filter((record) => record.stage === "qa_start" && record.taskId === null)
				.map((record) => record.note),
		).toEqual([
			"waiting for localai capacity: 1/1 model(s) loaded (held by 1 card(s) of other projects); queued: qa001",
		]);
	});
});
