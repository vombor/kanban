import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { accountObjectiveInput } from "../../../src/server/objective-input-accounting";
import { accountObjectiveLaunch } from "../../../src/server/objective-launch-accounting";
import { createTempDir } from "../../utilities/temp-dir";

const T0 = Date.parse("2026-10-18T10:00:00Z");
describe("native admission accounting preserves uncertainty and remains reporting-only", () => {
	it("serializes concurrent reservations before execution and keeps attempt/time/cost warnings without enabling enforcement", async () => {
		const temp = createTempDir("objective-reservations-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
					limits: { maxAttempts: 1, maxEstimatedUsd: 1 },
				}),
			);
			const id = randomUUID();
			const results = await Promise.all([
				store.reserve("foo", "dev01", id, "start"),
				store.reserve("foo", "dev01", id, "start"),
			]);
			expect(results.filter((result) => result?.duplicate)).toHaveLength(1);
			const second = await store.reserve("foo", "dev01", randomUUID(), "input");
			expect(second?.duplicate).toBe(false);
			const objective = (await store.read("foo")).objectives[0];
			expect(objective?.limits.mode).toBe("report");
			expect(objective?.reservations).toHaveLength(2);
			expect(objective?.reservations[1]?.report).toEqual(["attempt_limit", "cost_unknown"]);
			const restart = createObjectiveStore({ home: temp.path });
			await restart.interruptReservations("foo", T0 + 1000);
			expect((await restart.read("foo")).objectives[0]?.reservations.every((row) => row.state === "uncertain")).toBe(
				true,
			);
			const start = vi.fn();
			await expect(
				accountObjectiveLaunch({ accounting: restart, workspaceId: "foo", taskId: "dev01", requestId: id, start }),
			).resolves.toMatchObject({ ok: false });
			expect(start).not.toHaveBeenCalled();
		} finally {
			temp.cleanup();
		}
	});
	it("releases known non-delivery but retains output-only or failed execution as uncertain, without typing/replay side effects", async () => {
		const temp = createTempDir("objective-input-receipts-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			const response = {
				ok: false,
				status: "user_typing" as const,
				evidence: null,
				enterAttempts: 0,
				summary: null,
			};
			await accountObjectiveInput({
				accounting: store,
				workspaceId: "foo",
				taskId: "dev01",
				deliver: async () => response,
			});
			await accountObjectiveInput({
				accounting: store,
				workspaceId: "foo",
				taskId: "dev01",
				deliver: async () => ({ ...response, ok: true, status: "delivered", evidence: "output", enterAttempts: 1 }),
			});
			await expect(
				accountObjectiveLaunch({
					accounting: store,
					workspaceId: "foo",
					taskId: "dev01",
					start: async () => {
						throw new Error("ambiguous launch");
					},
				}),
			).rejects.toThrow("ambiguous launch");
			expect((await store.read("foo")).objectives[0]?.reservations.map((row) => row.state)).toEqual([
				"released",
				"uncertain",
				"uncertain",
			]);
			await expect(
				store.settle("foo", (await store.read("foo")).objectives[0]?.reservations[1]?.id ?? "missing", "released"),
			).rejects.toThrow("already committed");
		} finally {
			temp.cleanup();
		}
	});
});
