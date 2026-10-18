import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { objectiveCreateSchema, objectiveLimitsSchema } from "../../../src/core/objective-contract";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { getObjectivePaths } from "../../../src/state/kanban-home";

const createInput = () =>
	objectiveCreateSchema.parse({
		requestId: randomUUID(),
		title: "Verified feature",
		requirements: "Must satisfy the regression and retain user work.",
		taskIds: ["abc12"],
	});
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "native-objective-test-"));
	return { home, store: createObjectiveStore({ home }) };
}

describe("native objective durability", () => {
	it("pins immutable requirements before committing the manifest and retains them on a new store instance", async () => {
		const f = await fixture();
		const input = createInput();
		const objective = await f.store.create("project", input);
		expect(await f.store.readRequirements("project", objective.requirementsHash)).toBe(input.requirements);
		expect((await createObjectiveStore({ home: f.home }).read("project")).objectives[0]?.id).toBe(objective.id);
		expect(objective.estimatedUsd).toBeNull();
		expect(objective.status).toBe("awaiting_evidence");
		expect(objective.finalCommits).toEqual([]);
	});
	it("retries an exact create request without a second objective or requirement revision", async () => {
		const f = await fixture();
		const input = createInput();
		const first = await f.store.create("project", input);
		expect((await f.store.create("project", input)).id).toBe(first.id);
		expect((await f.store.read("project")).objectives).toHaveLength(1);
		await expect(f.store.create("project", { ...input, requirements: "Different acceptance" })).rejects.toThrow(
			"different objective data",
		);
	});
	it("serializes concurrent attachment claims instead of charging one task to two objectives", async () => {
		const f = await fixture();
		const results = await Promise.allSettled([
			f.store.create("project", createInput()),
			createObjectiveStore({ home: f.home }).create("project", createInput()),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect((await f.store.read("project")).objectives).toHaveLength(1);
	});
	it("rejects stale limit writes and retains unknown cost rather than claiming zero spend", async () => {
		const f = await fixture();
		const objective = await f.store.create("project", createInput());
		const input = {
			requestId: randomUUID(),
			id: objective.id,
			expectedRevision: 1,
			limits: objectiveLimitsSchema.parse({ maxAttempts: 3 }),
		};
		expect((await f.store.setLimits("project", input)).revision).toBe(2);
		await expect(f.store.setLimits("project", { ...input, requestId: randomUUID() })).rejects.toThrow(
			"latest revision",
		);
		expect((await f.store.read("project")).objectives[0]?.costCoverage).toBe("unknown");
	});
	it("refuses damaged requirements and corrupt journals without silently resetting either", async () => {
		const f = await fixture();
		const objective = await f.store.create("project", createInput());
		const paths = getObjectivePaths("project", f.home);
		await writeFile(join(paths.requirements, `${objective.requirementsHash}.md`), "tampered");
		await expect(f.store.readRequirements("project", objective.requirementsHash)).rejects.toThrow(
			"unavailable or changed",
		);
		await writeFile(paths.state, "");
		await expect(f.store.create("project", createInput())).rejects.toThrow("restore before");
		expect(await readFile(paths.state, "utf8")).toBe("");
	});
	it("refuses invalid data scopes and preserves separate projects", async () => {
		const f = await fixture();
		await f.store.create("one", createInput());
		expect((await f.store.read("two")).objectives).toEqual([]);
		expect(() => getObjectivePaths("../one", f.home)).toThrow("Invalid project objective scope");
	});
});
