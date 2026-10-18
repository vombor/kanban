import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import {
	type ObjectiveLimits,
	objectiveControlRequestSchema,
	objectiveCreateSchema,
	objectiveManualLineageSchema,
} from "../../../src/core/objective-contract";
import { createObjectiveApi } from "../../../src/objectives/objective-api";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { accountObjectiveInput } from "../../../src/server/objective-input-accounting";
import { accountObjectiveRawInput } from "../../../src/server/objective-raw-input";
import { accountObjectiveSessionStart } from "../../../src/server/objective-session-admission";
import { createTempDir } from "../../utilities/temp-dir";

const T0 = Date.parse("2026-10-18T10:00:00Z");
async function setup(limits: Partial<ObjectiveLimits> = {}) {
	const temp = createTempDir("objective-controls-");
	let now = T0;
	const store = createObjectiveStore({ home: temp.path, now: () => new Date(now), admissionScopeAvailable: true });
	const objective = await store.create(
		"own",
		objectiveCreateSchema.parse({
			requestId: randomUUID(),
			title: "Keep acceptance",
			requirements: "Closed experiment verdicts are immutable",
			taskIds: ["dev01", "dev02"],
			limits,
		}),
	);
	const read = async () => {
		const object = (await store.read("own")).objectives[0];
		if (!object) throw new Error("No fixture objective");
		return object;
	};
	const control = async (
		action: "pause" | "resume" | "override" | "acknowledge" | "revoke",
		target: { taskId?: string; kind?: "start" | "input"; reservationId?: string; controlId?: string } = {},
	) =>
		store.control(
			"own",
			objectiveControlRequestSchema.parse({
				requestId: randomUUID(),
				id: objective.id,
				expectedRevision: (await read()).revision,
				action,
				reason: "Explicit user review, not experiment approval",
				...target,
			}),
		);
	const enforce = async (extra: Partial<ObjectiveLimits> = {}) =>
		store.setLimits("own", {
			requestId: randomUUID(),
			id: objective.id,
			expectedRevision: (await read()).revision,
			acknowledgeAdmissionScope: true,
			limits: { ...(await read()).limits, mode: "enforce", ...extra },
		});
	return {
		temp,
		store,
		read,
		control,
		enforce,
		advance: (value: number) => {
			now = value;
		},
	};
}
const summary = () =>
	runtimeTaskSessionSummarySchema.parse({
		taskId: "dev01",
		state: "running",
		agentId: "claude",
		workspacePath: "/fixture",
		pid: 200,
		startedAt: T0 + 1000,
		stateChangedAt: T0 + 1000,
		updatedAt: T0 + 1000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
	});
describe("user-owned, opt-in Kanban admission controls", () => {
	it("pauses new physical starts (blank composers included), verified input and raw API chunks without invoking a process or writing text", async () => {
		const f = await setup();
		try {
			await f.control("pause");
			const start = vi.fn(async () => summary()),
				write = vi.fn(() => summary()),
				deliver = vi.fn();
			await expect(
				accountObjectiveSessionStart({ accounting: f.store, workspaceId: "own", taskId: "dev01", start }),
			).rejects.toThrow("user_paused");
			await expect(
				accountObjectiveRawInput({
					accounting: f.store,
					workspaceId: "own",
					taskId: "dev01",
					text: "draft",
					write,
				}),
			).rejects.toThrow("user_paused");
			expect(
				await accountObjectiveInput({ accounting: f.store, workspaceId: "own", taskId: "dev01", deliver }),
			).toMatchObject({ status: "busy", enterAttempts: 0 });
			expect(start).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
			expect(deliver).not.toHaveBeenCalled();
			const paused = await f.read();
			expect(paused.reservations).toEqual([]);
			expect(paused.requirementsHash).toBe((await f.read()).requirementsHash);
			await f.control("resume");
			expect((await f.store.check("own", "dev01", "start")).allowed).toBe(true);
			expect((await f.read()).reservations).toEqual([]);
		} finally {
			f.temp.cleanup();
		}
	});
	it("requires explicit boundary acknowledgement, keeps report default and serializes attempt-limit admission across own tasks", async () => {
		const f = await setup({ maxAttempts: 1 });
		try {
			let object = await f.read();
			expect(object.limits.mode).toBe("report");
			await expect(
				f.store.setLimits("own", {
					requestId: randomUUID(),
					id: object.id,
					expectedRevision: object.revision,
					limits: { ...object.limits, mode: "enforce" },
				}),
			).rejects.toThrow("acknowledgement");
			await f.enforce();
			const responses = await Promise.allSettled([
				f.store.reserve("own", "dev01", randomUUID(), "start"),
				f.store.reserve("own", "dev02", randomUUID(), "start"),
			]);
			expect(responses.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			object = await f.read();
			expect(object.reservations).toHaveLength(1);
			expect(object.estimatedUsd).toBeNull();
			expect(object.costCoverage).toBe("unknown");
		} finally {
			f.temp.cleanup();
		}
	});
	it("consumes one scoped override once, retaining counts, history and exact-retry receipts without broadening it to input or another task", async () => {
		const f = await setup({ maxAttempts: 1 });
		try {
			await f.enforce();
			const prior = randomUUID();
			await f.store.reserve("own", "dev01", prior, "start");
			await f.store.settle("own", prior, "started", T0 + 1);
			const object = await f.read(),
				request = objectiveControlRequestSchema.parse({
					requestId: randomUUID(),
					id: object.id,
					expectedRevision: object.revision,
					action: "override",
					reason: "One authorized recovery admission; preserve experiment verdict",
					taskId: "dev02",
					kind: "start",
				});
			await f.store.control("own", request);
			expect((await f.store.check("own", "dev02", "input")).allowed).toBe(false);
			expect((await f.store.check("own", "dev01", "start")).allowed).toBe(false);
			const id = randomUUID();
			await f.store.reserve("own", "dev02", id, "start");
			await f.store.settle("own", id, "started", T0 + 2);
			await f.store.control("own", request);
			const after = await f.read();
			expect(after.controls).toHaveLength(1);
			expect(after.controls[0]?.usedBy).toBe(id);
			expect(after.reservations).toHaveLength(2);
			expect((await f.store.check("own", "dev02", "start")).allowed).toBe(false);
			await expect(f.store.control("own", { ...request, reason: "Changed payload" })).rejects.toThrow(
				"different objective data",
			);
		} finally {
			f.temp.cleanup();
		}
	});
	it("holds unknown cost unless the user explicitly chooses allow or grants one override; never changes unknown coverage to zero", async () => {
		const f = await setup({ maxEstimatedUsd: 1 });
		try {
			await f.enforce();
			expect(await f.store.check("own", "dev01", "start")).toMatchObject({ allowed: false, reason: "cost_unknown" });
			await f.enforce({ unknownCost: "allow" });
			expect((await f.store.check("own", "dev01", "start")).allowed).toBe(true);
			expect((await f.read()).estimatedUsd).toBeNull();
			expect((await f.read()).observedEstimatedUsd).toBeNull();
			expect((await f.read()).costCoverage).toBe("unknown");
		} finally {
			f.temp.cleanup();
		}
	});
	it("revokes unused overrides without refunding consumed admissions or deleting the approval audit", async () => {
		const f = await setup({ maxAttempts: 1 });
		try {
			await f.enforce();
			const id = randomUUID();
			await f.store.reserve("own", "dev01", id, "start");
			await f.store.settle("own", id, "started", T0 + 1);
			const granted = await f.control("override", { taskId: "dev02", kind: "start" }),
				grant = granted.controls.at(-1);
			if (!grant) throw new Error("No test grant");
			await f.control("revoke", { controlId: grant.id });
			const after = await f.read();
			expect(after.controls).toHaveLength(2);
			expect(after.controls[0]?.revokedBy).toBe(after.controls[1]?.id);
			expect(after.reservations).toHaveLength(1);
			expect((await f.store.check("own", "dev02", "start")).allowed).toBe(false);
			await expect(f.control("revoke", { controlId: grant.id })).rejects.toThrow("unused own override");
		} finally {
			f.temp.cleanup();
		}
	});
	it("preserves unresolved starts across restart; acknowledgement keeps the charge and never permits replaying their exact reservation id", async () => {
		const f = await setup();
		try {
			await f.enforce();
			const id = randomUUID();
			await f.store.reserve("own", "dev01", id, "start");
			await f.store.interruptReservations("own", T0 + 1000);
			expect(await f.store.check("own", "dev02", "start")).toMatchObject({
				allowed: false,
				reason: "delivery_uncertain",
			});
			await f.control("acknowledge", { reservationId: id });
			expect((await f.read()).reservations[0]?.state).toBe("uncertain");
			expect((await f.store.check("own", "dev02", "start")).allowed).toBe(true);
			const start = vi.fn();
			await expect(
				accountObjectiveSessionStart({
					accounting: f.store,
					workspaceId: "own",
					taskId: "dev01",
					requestId: id,
					start,
				}),
			).rejects.toThrow("instead of replaying");
			expect(start).not.toHaveBeenCalled();
			expect((await f.read()).status).not.toBe("completed");
		} finally {
			f.temp.cleanup();
		}
	});
	it("does not renew elapsed limits by pause/resume and records raw Enter as uncertain rather than proof that a model ran", async () => {
		const f = await setup({ maxElapsedMinutes: 1 });
		try {
			await f.enforce();
			f.advance(T0 + 61000);
			await f.control("pause");
			await f.control("resume");
			expect(await f.store.check("own", "dev01", "start")).toMatchObject({ allowed: false, reason: "time_limit" });
			await f.control("override", { taskId: "dev01", kind: "input" });
			const write = vi.fn(() => summary());
			await accountObjectiveRawInput({
				accounting: f.store,
				workspaceId: "own",
				taskId: "dev01",
				text: "\r",
				write,
			});
			expect(write).toHaveBeenCalledOnce();
			expect((await f.read()).reservations.at(-1)?.state).toBe("uncertain");
		} finally {
			f.temp.cleanup();
		}
	});
	it("binds planned manual children with exact retry before creation; ordinary references or unknown callers grant no lineage or execution", async () => {
		const f = await setup();
		try {
			let known = new Set(["dev01", "dev02"]);
			const api = createObjectiveApi({
				store: f.store,
				taskIds: async () => known,
				taskEligibility: async () => ({ known, unstarted: new Set(["dev02"]) }),
				admissionScopeAvailable: true,
				now: () => T0,
			});
			const object = await f.read(),
				request = objectiveManualLineageSchema.parse({
					id: object.id,
					requestId: randomUUID(),
					expectedRevision: object.revision,
					parentTaskId: "dev01",
					taskIds: ["child1", "child2"],
					kind: "runoff",
					planned: true,
				});
			await expect(api.manualLineage({ kind: "unknown", reason: "fixture" }, "own", request)).rejects.toThrow(
				"user-owned",
			);
			await api.manualLineage({ kind: "user" }, "own", request);
			known = new Set([...known, "child1", "child2"]);
			await api.manualLineage({ kind: "user" }, "own", request);
			const after = await f.read();
			expect(after.tasks.filter((task) => task.kind === "runoff")).toHaveLength(2);
			expect(after.reservations).toEqual([]);
			expect(after.attempts).toEqual([]);
			expect(after.requirementsHash).toBe(object.requirementsHash);
			await expect(api.manualLineage({ kind: "user" }, "own", { ...request, taskIds: ["other1"] })).rejects.toThrow(
				"different objective data",
			);
			await expect(
				api.control(
					{ kind: "unknown", reason: "fixture" },
					"own",
					objectiveControlRequestSchema.parse({
						id: object.id,
						requestId: randomUUID(),
						expectedRevision: after.revision,
						action: "resume",
						reason: "not authorized",
					}),
				),
			).rejects.toThrow("user-owned");
		} finally {
			f.temp.cleanup();
		}
	});
});
