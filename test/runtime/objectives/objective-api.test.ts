import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { objectiveCreateSchema, objectiveLimitsRequestSchema } from "../../../src/core/objective-contract";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { authorizeObjectiveCaller, createObjectiveApi } from "../../../src/objectives/objective-api";
import { createObjectiveStore } from "../../../src/objectives/objective-store";

const caller = (workspaceId: string): RuntimeCaller => ({
	kind: "session",
	via: "credential",
	session: { workspaceId, taskId: "abc12", role: "card", agentId: "codex", cwd: "/fixture" },
});
const input = () =>
	objectiveCreateSchema.parse({
		requestId: randomUUID(),
		title: "Objective",
		requirements: "The regression must pass",
		taskIds: ["abc12"],
	});

describe("strict runtime objective boundary", () => {
	it("gives scoped guidance but permits only the user to recheck retained owner evidence", async () => {
		const home = await mkdtemp(join(tmpdir(), "objective-recheck-api-"));
		const recheck = vi.fn(async (_workspaceId: string) => {});
		const api = createObjectiveApi({
			store: createObjectiveStore({ home }),
			taskIds: async () => new Set(["abc12"]),
			recheck,
		});
		const objective = await api.create({ kind: "user" }, "own", input());
		const read = await api.read(caller("own"), "own", objective.id);
		expect(read.handoffGuide).toMatchObject({ owner: "supervision", executionEnforcementAvailable: false });
		expect(read.handoffGuide?.commands[1]).toEqual([
			"kanban",
			"objective",
			"recheck",
			objective.id,
			"--project",
			"own",
		]);
		for (const denied of [caller("own"), caller("other"), { kind: "unknown" as const, reason: "fixture" }])
			await expect(api.recheck(denied, "own", objective.id)).rejects.toThrow("user-owned");
		expect(recheck).not.toHaveBeenCalled();
		const after = await api.recheck({ kind: "user" }, "own", objective.id);
		expect(recheck).toHaveBeenCalledExactlyOnceWith("own");
		expect(after.objective.status).toBe("awaiting_evidence");
		expect(after.objective.finalCommits).toEqual([]);
	});
	it("keeps limits revision-checked/report-only, and a failed owner refresh cannot claim resolution", async () => {
		const home = await mkdtemp(join(tmpdir(), "objective-recheck-failure-"));
		const api = createObjectiveApi({
			store: createObjectiveStore({ home }),
			taskIds: async () => new Set(["abc12"]),
			recheck: async () => {
				throw new Error("damaged owner receipt");
			},
		});
		const objective = await api.create({ kind: "user" }, "own", input());
		await expect(api.recheck({ kind: "user" }, "own", objective.id)).rejects.toThrow("preserve evidence");
		const limits = objectiveLimitsRequestSchema.parse({
			id: objective.id,
			requestId: randomUUID(),
			expectedRevision: objective.revision,
			limits: { maxAttempts: 3, maxElapsedMinutes: 10, maxEstimatedUsd: 1 },
		});
		await expect(api.setLimits(caller("own"), "own", limits)).rejects.toThrow("user-owned");
		const report = await api.setLimits({ kind: "user" }, "own", limits);
		expect(report.limits.mode).toBe("report");
		expect(report.costCoverage).toBe("unknown");
		expect(report.estimatedUsd).toBeNull();
		await expect(api.setLimits({ kind: "user" }, "own", { ...limits, requestId: randomUUID() })).rejects.toThrow(
			"latest revision",
		);
		await expect(
			api.setLimits({ kind: "user" }, "own", {
				...limits,
				requestId: randomUUID(),
				expectedRevision: report.revision,
				limits: { ...report.limits, mode: "enforce" },
			}),
		).rejects.toThrow("report mode only");
	});
	it("does not widen reads for unknown/cross-project callers or grants/isolation-off", () => {
		expect(() => authorizeObjectiveCaller(caller("own"), "other")).toThrow("identified sessions");
		expect(() => authorizeObjectiveCaller({ kind: "unknown", reason: "fixture" }, "own")).toThrow(
			"identified sessions",
		);
		expect(() => authorizeObjectiveCaller(caller("own"), "own")).not.toThrow();
	});
	it("never gives a project agent authority over requirement/policy/budget mutations", () => {
		expect(() => authorizeObjectiveCaller(caller("own"), "own", true)).toThrow("user-owned");
	});
	it("checks native task membership and rejects unavailable enforcement instead of pretending a limit is active", async () => {
		const home = await mkdtemp(join(tmpdir(), "native-objective-api-"));
		const api = createObjectiveApi({
			store: createObjectiveStore({ home }),
			taskIds: async () => new Set(["abc12"]),
		});
		const objective = await api.create({ kind: "user" }, "project", input());
		expect((await api.read(caller("project"), "project", objective.id)).requirements).toBe(
			"The regression must pass",
		);
		await expect(api.create({ kind: "user" }, "project", { ...input(), taskIds: ["other"] })).rejects.toThrow(
			"current board",
		);
		await expect(
			api.create({ kind: "user" }, "project", { ...input(), limits: { ...input().limits, mode: "enforce" } }),
		).rejects.toThrow("boundary acknowledgement");
	});
});
