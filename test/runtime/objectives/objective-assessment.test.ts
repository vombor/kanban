import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import type { ObjectiveEvidence } from "../../../src/core/objective-evidence";
import { assessObjective } from "../../../src/objectives/objective-assessment";
import { createObjectiveStore, objectiveDigest } from "../../../src/objectives/objective-store";

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "objective-evidence-"));
	const store = createObjectiveStore({ home, now: () => new Date("2026-10-17T09:00:00Z") });
	const objective = await store.create(
		"project",
		objectiveCreateSchema.parse({
			requestId: randomUUID(),
			title: "Verified objective",
			requirements: "Regression passes",
			taskIds: ["abc12"],
		}),
	);
	const binding = await store.binding("project", "abc12");
	if (!binding) throw new Error("Missing binding");
	const fields = { taskId: "abc12", binding, snapshot: "a".repeat(40), at: "2026-10-17T10:00:00Z" };
	const checks: ObjectiveEvidence = {
		...fields,
		id: objectiveDigest("checks"),
		kind: "checks",
		scripts: [{ name: "test", status: "pass", harness: false }],
	};
	const qa: ObjectiveEvidence = {
		...fields,
		id: objectiveDigest("qa"),
		kind: "qa",
		qaTaskId: "qa123",
		verdict: "PASS",
	};
	const land: ObjectiveEvidence = {
		...fields,
		id: objectiveDigest("land"),
		kind: "landed",
		commit: "b".repeat(40),
		baseRef: "main",
	};
	return { store, objective, checks, qa, land };
}

describe("objective completion uses owner evidence, never an agent claim", () => {
	it("does not complete from landing alone; requires exact-snapshot checks and QA", async () => {
		const f = await fixture();
		await f.store.record("project", f.land);
		expect((await f.store.read("project")).objectives[0]?.status).toBe("held");
		await f.store.record("project", f.checks);
		expect((await f.store.read("project")).objectives[0]?.status).toBe("held");
		await f.store.record("project", f.qa);
		const objective = (await f.store.read("project")).objectives[0];
		expect(objective?.status).toBe("completed");
		expect(objective?.finalCommits).toEqual([f.land.kind === "landed" ? f.land.commit : ""]);
	});
	it("deduplicates exact owner retries and refuses changed facts under the same identity", async () => {
		const f = await fixture();
		await f.store.record("project", f.checks);
		await f.store.record("project", f.checks);
		expect((await f.store.read("project")).objectives[0]?.evidence).toHaveLength(1);
		await expect(f.store.record("project", { ...f.checks, snapshot: "c".repeat(40) })).rejects.toThrow(
			"different facts",
		);
	});
	it("does not adopt evidence written before the user pinned requirements", async () => {
		const f = await fixture();
		await expect(f.store.record("project", { ...f.land, at: "2026-10-17T08:59:59Z" })).rejects.toThrow(
			"predates the objective",
		);
		expect((await f.store.read("project")).objectives[0]?.evidence).toEqual([]);
	});
	it("does not choose PASS by insertion order when simultaneous QA receipts disagree", async () => {
		const f = await fixture();
		if (f.qa.kind !== "qa") throw new Error("Bad fixture");
		const failed = { ...f.qa, id: objectiveDigest("different-qa"), qaTaskId: "qa456", verdict: "FAIL" as const };
		for (const receipts of [
			[f.qa, failed],
			[failed, f.qa],
		]) {
			f.objective.evidence = [f.land, f.checks, ...receipts];
			expect(assessObjective(f.objective, "2026-10-17T10:01:00Z").status).not.toBe("completed");
		}
	});
	it("rejects stale snapshots, different requirement revisions and harness-only checks", async () => {
		const f = await fixture();
		f.objective.evidence = [f.land, { ...f.qa, snapshot: "c".repeat(40) }, f.checks];
		expect(assessObjective(f.objective, "2026-10-17T10:01:00Z").status).not.toBe("completed");
		f.objective.evidence = [
			f.land,
			{ ...f.qa, binding: { ...f.qa.binding, requirementsHash: "d".repeat(64) } },
			f.checks,
		];
		expect(assessObjective(f.objective, "2026-10-17T10:01:00Z").status).not.toBe("completed");
		if (f.checks.kind !== "checks") throw new Error("Bad fixture");
		f.objective.evidence = [
			f.land,
			f.qa,
			{ ...f.checks, scripts: [{ name: "test", status: "pass", harness: true }] },
		];
		expect(assessObjective(f.objective, "2026-10-17T10:01:00Z").status).not.toBe("completed");
	});
});
