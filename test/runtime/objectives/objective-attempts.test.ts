import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import type { ObjectiveSessionObservation } from "../../../src/objectives/objective-attempts";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { createTempDir } from "../../utilities/temp-dir";

const T0 = Date.parse("2026-10-17T10:00:00Z");
const running = (taskId = "dev01", at = T0 + 1000): ObjectiveSessionObservation => ({
	taskId,
	startedAt: at,
	stateChangedAt: at,
	updatedAt: at,
	state: "running",
	live: true,
	settled: false,
});
describe("native attempt reconciliation observes, never restarts", () => {
	it("deduplicates sweeps, waits for settled Review, retains interrupted runs across restart and missing cards", async () => {
		const temp = createTempDir("objective-attempts-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Regression",
					taskIds: ["dev01"],
				}),
			);
			await store.observe("foo", [running()]);
			await store.observe("foo", [running()]);
			expect((await store.read("foo")).objectives[0]?.attempts).toHaveLength(1);
			const review = { ...running(), state: "awaiting_review", stateChangedAt: T0 + 2000, updatedAt: T0 + 2000 };
			await store.observe("foo", [review]);
			expect((await store.read("foo")).objectives[0]?.attempts[0]?.state).toBe("running");
			await store.observe("foo", [{ ...review, settled: true }]);
			expect((await store.read("foo")).objectives[0]?.attempts[0]).toMatchObject({
				state: "settled",
				endedAt: new Date(T0 + 2000).toISOString(),
			});
			await store.observe("foo", [running("dev01", T0 + 3000)]);
			const restarted = createObjectiveStore({ home: temp.path });
			await restarted.observe("foo", [{ ...running("dev01", T0 + 3000), updatedAt: T0 + 60_000, live: false }]);
			expect((await restarted.read("foo")).objectives[0]?.attempts[1]).toMatchObject({
				state: "interrupted",
				endedAt: new Date(T0 + 3000).toISOString(),
			});
			await restarted.observe("foo", []);
			expect((await restarted.read("foo")).objectives[0]?.attempts).toHaveLength(2);
			expect((await restarted.read("foo")).objectives[0]?.status).not.toBe("completed");
		} finally {
			temp.cleanup();
		}
	});
	it("does not adopt pre-requirement turns or end other tasks when observing one activity", async () => {
		const temp = createTempDir("objective-attempts-partial-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Regression",
					taskIds: ["dev01", "dev02"],
				}),
			);
			await store.observe("foo", [running("dev01", T0 - 1000)]);
			expect((await store.read("foo")).objectives[0]?.attempts).toEqual([]);
			await store.observe("foo", [running("dev01"), running("dev02")]);
			await store.observe("foo", [{ ...running(), updatedAt: T0 + 2000 }], false);
			expect((await store.read("foo")).objectives[0]?.attempts.map((attempt) => attempt.state)).toEqual([
				"running",
				"running",
			]);
			await store.observe("foo", [running("dev02")]);
			expect((await store.read("foo")).objectives[0]?.attempts[0]?.state).toBe("unknown");
		} finally {
			temp.cleanup();
		}
	});
});
