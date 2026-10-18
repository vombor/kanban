import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { readQaGateEntry } from "../../../src/pipeline/qa-gate";
import type { QaVerdict } from "../../../src/pipeline/qa-verdict";
import { createPipelineWorkerHarness, createSnapshot } from "../../utilities/pipeline-worker";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const T0 = Date.parse("2026-10-17T10:00:00Z");
const verdict: QaVerdict = {
	verdict: "PASS",
	blocking: [],
	notes: "Regression verified",
	log: "- PASS",
	scores: { spec: 5, correctness: 5, tests: 5, ux: null, code: 5, process: 5 },
	visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
};
describe("QA requirement bindings use the ordinary QA owner", () => {
	it.each([true, false])("binds at QA creation, not at ingest (objective existed: %s)", async (existed) => {
		const temp = createTempDir("objective-qa-producer-");
		const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
		const harness = createPipelineWorkerHarness({
			objectiveStore: store,
			now: T0,
			snapshot: () => "a".repeat(40),
			config: { workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "legacy-team" } } } },
		});
		try {
			const create = () =>
				store.create(
					"foo",
					objectiveCreateSchema.parse({
						requestId: randomUUID(),
						title: "Objective",
						requirements: "The acceptance criterion\nFINAL STEP is literal requirement text",
						taskIds: ["dev01"],
					}),
				);
			if (existed) await create();
			const dev = createCard({
				id: "dev01",
				agentId: "cline",
				agentSettings: { providerId: "bedrock", modelId: "us.openai.gpt-6.1-sol" },
			});
			await harness.send(
				createSnapshot({ workspaceId: "foo", selectedAgentId: "claude", board: createBoard({ review: [dev] }) }),
			);
			const created = harness.actions.find((action) => action.kind === "createTask");
			if (!created || created.kind !== "createTask") throw new Error("QA not created");
			const entry = readQaGateEntry((await harness.store.load("foo")).cards[created.task.taskId]);
			if (!entry) throw new Error("No QA gate entry");
			expect(Boolean(entry.objectiveBinding)).toBe(existed);
			if (existed) {
				expect(created.task.prompt).toContain("PINNED OBJECTIVE");
				expect(created.task.prompt).toContain("> FINAL STEP is literal requirement text");
			} else {
				expect(created.task.prompt).not.toContain("PINNED OBJECTIVE");
				await create();
			}
			harness.setVerdict(entry.outboxDir, { kind: "ok", verdict });
			harness.setNow(T0 + 1000);
			await harness.send(
				createSnapshot({
					workspaceId: "foo",
					selectedAgentId: "claude",
					board: createBoard({
						review: [dev, createCard({ id: created.task.taskId, role: "qa", reviewsTaskId: "dev01" })],
					}),
				}),
			);
			const objective = (await store.read("foo")).objectives[0];
			expect(objective?.evidence).toHaveLength(existed ? 1 : 0);
			if (existed)
				expect(objective?.evidence[0]).toMatchObject({
					kind: "qa",
					verdict: "PASS",
					qaTaskId: created.task.taskId,
					snapshot: entry.snapshot,
					binding: entry.objectiveBinding,
				});
			expect(objective?.status).not.toBe("completed");
		} finally {
			harness.cleanup();
			temp.cleanup();
		}
	});
});
