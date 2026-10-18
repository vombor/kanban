import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import type { ObjectiveEvidence } from "../../../src/core/objective-evidence";
import { objectiveDigest } from "../../../src/objectives/objective-identity";
import { createObjectiveEvidenceOwner, replayObjectiveReceipts } from "../../../src/objectives/objective-receipts";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { getObjectivePaths } from "../../../src/state/kanban-home";
import { createReworkHarness, failVerdict, REWORK_T0 } from "../../utilities/rework-stage";
import { createTempDir } from "../../utilities/temp-dir";
import { createCard } from "../../utilities/workspace-state-store";

async function fixture() {
	const temp = createTempDir("objective-lineage-");
	const store = createObjectiveStore({ home: temp.path, now: () => new Date(REWORK_T0 - 60_000) });
	const objective = await store.create(
		"foo",
		objectiveCreateSchema.parse({
			requestId: randomUUID(),
			title: "Objective",
			requirements: "Pinned regression",
			taskIds: ["d1111"],
		}),
	);
	const binding = await store.binding("foo", "d1111");
	if (!binding) throw new Error("No binding");
	return { temp, store, objective, binding };
}

describe("explicit objective lineage, not title/prompt inference", () => {
	it("retains and deduplicates children; refuses duplicate ownership, QA parents and changed pins", async () => {
		const f = await fixture();
		try {
			const child = {
				binding: f.binding,
				taskId: "s0001",
				parentTaskId: "d1111",
				kind: "escalation" as const,
				at: new Date(REWORK_T0).toISOString(),
			};
			await Promise.all([f.store.attach("foo", child), f.store.attach("foo", child)]);
			expect((await f.store.read("foo")).objectives[0]?.tasks).toHaveLength(2);
			await f.store.attach("foo", { ...child, taskId: "qa001", parentTaskId: "s0001", kind: "qa" });
			await expect(f.store.attach("foo", { ...child, taskId: "s0002", parentTaskId: "qa001" })).rejects.toThrow(
				"implementation parent",
			);
			await expect(
				f.store.attach("foo", { ...child, binding: { ...f.binding, requirementsHash: "a".repeat(64) } }),
			).rejects.toThrow("pinned objective parent");
			await expect(f.store.attach("foo", { ...child, kind: "runoff" })).rejects.toThrow(
				"different objective lineage",
			);
			await expect(f.store.attach("other", child)).rejects.toThrow();
		} finally {
			f.temp.cleanup();
		}
	});
	it("recovers out-of-order durable sibling/QA links after restart, never adopts old unbound siblings", async () => {
		const f = await fixture();
		try {
			const pipeline = createPipelineStateStore({
				getStatePath: () => join(f.temp.path, "pipeline.json"),
				getLegacyChecksStatePaths: () => [],
			});
			await pipeline.update("foo", (state) => {
				state.cards = {
					qa001: { qaGate: { objectiveBinding: f.binding, reviewsTaskId: "s0001", createdAt: REWORK_T0 + 1000 } },
					s0001: {
						objectiveLineage: {
							binding: f.binding,
							taskId: "s0001",
							parentTaskId: "d1111",
							kind: "runoff",
							at: new Date(REWORK_T0).toISOString(),
						},
					},
					old01: { sibling: { of: "d1111", kind: "runoff", at: new Date(REWORK_T0 - 1).toISOString() } },
				};
				return state;
			});
			const restarted = createObjectiveStore({ home: f.temp.path });
			await replayObjectiveReceipts(restarted, "foo", await pipeline.load("foo"));
			await replayObjectiveReceipts(restarted, "foo", await pipeline.load("foo"));
			expect((await restarted.read("foo")).objectives[0]?.tasks.map((task) => task.taskId)).toEqual([
				"d1111",
				"s0001",
				"qa001",
			]);
		} finally {
			f.temp.cleanup();
		}
	});
	it("accepts a landed replacement only with its own exact-snapshot checks/QA, retaining losing evidence", async () => {
		const f = await fixture();
		try {
			const at = new Date(REWORK_T0).toISOString();
			await f.store.attach("foo", {
				binding: f.binding,
				taskId: "s0001",
				parentTaskId: "d1111",
				kind: "runoff",
				at,
			});
			const base = { binding: f.binding, at: new Date(REWORK_T0 + 10000).toISOString(), snapshot: "a".repeat(40) };
			const check: ObjectiveEvidence = {
				...base,
				taskId: "d1111",
				kind: "checks",
				id: objectiveDigest("loser checks"),
				scripts: [{ name: "test", status: "pass", harness: false }],
			};
			await f.store.record("foo", check);
			await f.store.record("foo", {
				...base,
				taskId: "s0001",
				kind: "qa",
				id: objectiveDigest("winner qa"),
				qaTaskId: "qa001",
				verdict: "PASS",
			});
			await f.store.record("foo", {
				...base,
				taskId: "s0001",
				kind: "landed",
				id: objectiveDigest("winner land"),
				commit: "b".repeat(40),
				baseRef: "main",
			});
			expect((await f.store.read("foo")).objectives[0]?.status).not.toBe("completed");
			await f.store.record("foo", { ...check, taskId: "s0001", id: objectiveDigest("winner checks") });
			const completed = (await f.store.read("foo")).objectives[0];
			expect(completed?.status).toBe("completed");
			expect(completed?.finalCommits).toEqual(["b".repeat(40)]);
			expect(completed?.evidence).toHaveLength(4);
		} finally {
			f.temp.cleanup();
		}
	});
	it("does not repair corrupt/missing parent graphs by inventing membership", async () => {
		const f = await fixture();
		try {
			const path = getObjectivePaths("foo", f.temp.path).state;
			const state = await f.store.read("foo");
			state.objectives[0]?.tasks.push({
				taskId: "s0001",
				parentTaskId: "missing",
				kind: "escalation",
				attachedAt: new Date(REWORK_T0).toISOString(),
			});
			await writeFile(path, JSON.stringify(state));
			const before = await readFile(path, "utf8");
			await expect(f.store.read("foo")).rejects.toThrow("corrupt");
			expect(await readFile(path, "utf8")).toBe(before);
		} finally {
			f.temp.cleanup();
		}
	});
	it("pins an automatic escalation before its ordinary start, preserving the existing approval policy", async () => {
		const f = await fixture();
		const owner = createObjectiveEvidenceOwner(f.store);
		const harness = createReworkHarness({
			objectives: owner,
			onFail: () => ({
				action: "escalate",
				to: { agentId: "codex", model: { provider: null, model: "fixture-model" } },
				requireApproval: false,
				reason: "fixture escalation",
			}),
		});
		try {
			await harness.seed("d1111", { qaVerdicts: [failVerdict(1)] });
			await harness.tick({ review: [createCard({ id: "d1111", agentId: "cline" })] });
			const created = harness.actions.find((action) => action.kind === "createTask");
			if (!created || created.kind !== "createTask") throw new Error("No sibling");
			expect((await f.store.read("foo")).objectives[0]?.tasks).toContainEqual({
				taskId: created.task.taskId,
				kind: "escalation",
				parentTaskId: "d1111",
				attachedAt: new Date(REWORK_T0).toISOString(),
			});
			expect((await harness.entry(created.task.taskId))?.objectiveLineage).toMatchObject({
				binding: f.binding,
				taskId: created.task.taskId,
				kind: "escalation",
			});
			expect(
				harness.actions.some((action) => action.kind === "startTask" && action.taskId === created.task.taskId),
			).toBe(true);
		} finally {
			harness.cleanup();
			f.temp.cleanup();
		}
	});
});
