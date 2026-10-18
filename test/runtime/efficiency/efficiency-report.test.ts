import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { objectiveSchema } from "../../../src/core/objective-contract";
import { objectiveUsageRecordSchema } from "../../../src/core/objective-usage";
import { createEfficiencyApi } from "../../../src/efficiency/efficiency-api";
import { buildEfficiencyReport, unionDuration } from "../../../src/efficiency/report";
import { createEfficiencyTimingStore } from "../../../src/efficiency/timing-store";
import { createEfficiencyObserver, efficiencySample } from "../../../src/server/efficiency-observer";
import { getEfficiencyStatePath } from "../../../src/state/kanban-home";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

function objective() {
	return objectiveSchema.parse({
		id: "obj-00000000-0000-4000-8000-000000000001",
		title: "Owned report fixture",
		createdAt: "1970-01-01T00:00:00.000Z",
		updatedAt: "1970-01-01T00:00:30.000Z",
		revision: 1,
		requirementsHash: "a".repeat(64),
		policy: {},
		limits: {},
		tasks: [
			{ taskId: "dev1", kind: "dev", parentTaskId: null, attachedAt: "1970-01-01T00:00:00.000Z" },
			{ taskId: "qa1", kind: "qa", parentTaskId: "dev1", attachedAt: "1970-01-01T00:00:01.000Z" },
		],
		attempts: [],
		status: "awaiting_evidence",
		handoff: null,
		estimatedUsd: null,
		costCoverage: "unknown",
		finalCommits: [],
	});
}
function usage(estimatedUsd: number | null, version: string, tokens = 100) {
	return objectiveUsageRecordSchema.parse({
		id: "b".repeat(64),
		version: version.repeat(64),
		taskId: "dev1",
		requirementsHash: "a".repeat(64),
		observedAt: "1970-01-01T00:00:20.000Z",
		attemptId: null,
		observation: {
			key: "backend:request:1",
			agent: "claude",
			basis: "request",
			at: 10000,
			model: "fixture",
			provider: "bedrock",
			tokens: { input: tokens, output: 20, cacheRead: 50, cacheWrite: 0 },
			uncertainty: [],
		},
		price:
			estimatedUsd === null
				? null
				: {
						revision: "c".repeat(64),
						source: "configured",
						kind: "table_estimate",
						rates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
						estimatedUsd,
					},
		uncertainty: [],
	});
}
describe("read-only efficiency/timing reports", () => {
	it("waits for its owned in-flight observation at shutdown and never samples again", async () => {
		vi.useFakeTimers();
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const sample = vi.fn(async () => {
				await gate;
				return { labels: {}, counters: {} };
			});
			const persist = vi.fn(async () => {}),
				warn = vi.fn();
			const observer = createEfficiencyObserver({
				store: {
					read: async () => ({ version: 1, spans: [], agentSamples: [], last: null, gaps: 0 }),
					sample: persist,
				},
				workspaces: () => ["demo"],
				sample,
				warn,
			});
			let closed = false;
			const closing = observer.close().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			release();
			await closing;
			await vi.advanceTimersByTimeAsync(30000);
			expect(sample).toHaveBeenCalledTimes(1);
			expect(persist).toHaveBeenCalledTimes(1);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("coalesces contiguous occupancy and refuses retention overflow without evicting evidence", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const store = createEfficiencyTimingStore(homePath),
				labels = { dev1: ["agent_running" as const] };
			for (let n = 0; n < 4; n++)
				await store.sample("demo", { serverId: "one", at: 1000 + n * 10000, labels, counters: { dev1: n * 2000 } });
			const state = await store.read("demo");
			expect(state.spans).toEqual([{ taskId: "dev1", category: "agent_running", start: 1000, end: 31000 }]);
			expect(state.agentSamples).toEqual([{ taskId: "dev1", start: 1000, end: 31000, ms: 6000 }]);
			state.spans = Array.from({ length: 10000 }, (_, n) => ({
				taskId: `old${n}`,
				category: "held" as const,
				start: 0,
				end: 1,
			}));
			const path = getEfficiencyStatePath("demo", homePath),
				retained = JSON.stringify(state);
			await writeFile(path, retained);
			await expect(
				store.sample("demo", { serverId: "one", at: 41000, labels, counters: { dev1: 8000 } }),
			).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe(retained);
		}));
	it("includes retained plan descendants such as losing/pruned siblings without granting acceptance", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const source = objective(),
				timing = createEfficiencyTimingStore(homePath);
			await timing.sample("demo", {
				serverId: "fixture",
				at: 1000,
				labels: { loser: ["agent_running"] },
				counters: { loser: 0 },
			});
			await timing.sample("demo", {
				serverId: "fixture",
				at: 11000,
				labels: { loser: ["agent_running"] },
				counters: { loser: 4000 },
			});
			const api = createEfficiencyApi({
				objectives: { read: async () => ({ version: 1, revision: 1, objectives: [source], receipts: [] }) },
				plans: {
					read: async () => ({
						version: 1,
						plans: {
							plan1: {
								taskId: "plan1",
								slug: "fixture",
								title: "Fixture plan",
								createdAt: "2026-10-18T00:00:00.000Z",
								kit: "default",
								agentId: "claude",
								providerId: null,
								modelId: null,
								startInPlanMode: false,
								approval: null,
								metrics: null,
								expansion: {
									status: "done",
									startedAt: "2026-10-18T00:00:00.000Z",
									finishedAt: "2026-10-18T01:00:00.000Z",
									breakdownSha256: "a".repeat(64),
									cards: { implementation: "dev1" },
									links: [],
								},
							},
						},
					}),
				},
				contexts: {
					bindings: async () => [
						{ taskId: "loser", planTaskId: "plan1" },
						{ taskId: "qa1", planTaskId: "plan1" },
					],
				},
				timing,
				board: async () => createBoard({}),
				now: () => 12000,
			});
			const report = await api.report({ kind: "user" }, "demo", { planTaskId: "plan1" });
			expect(report.taskCount).toBe(3);
			expect(report.observedAgentRunningMs).toBe(4000);
			expect(report.totalEstimatedUsd).toBeNull();
			expect(report.authority).toBe("report_only_not_acceptance_or_billing");
		}));
	it("uses native liveness/counters rather than output or hydrated running state to count active windows", () => {
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "dev1",
			state: "running",
			agentId: "claude",
			workspacePath: "/owned",
			pid: 123,
			startedAt: 1000,
			stateChangedAt: 1000,
			updatedAt: 10000,
			lastOutputAt: 100000,
			reviewReason: null,
			exitCode: null,
			runningMs: 5000,
		});
		const result = efficiencySample({
			sessions: [summary, { ...summary, taskId: "other" }],
			stages: [],
			isLive: () => false,
			taskIds: new Set(["dev1"]),
			now: 100000,
			settleMs: 12000,
		});
		expect(result.labels.dev1).toEqual([]);
		expect(result.counters.dev1).toBe(14000);
		expect(result.counters.other).toBeUndefined();
	});
	it("unions overlapping elapsed windows instead of treating summed concurrent stages as elapsed work", () => {
		expect(
			unionDuration([
				{ start: 0, end: 10000 },
				{ start: 5000, end: 15000 },
				{ start: 20000, end: 22000 },
			]),
		).toBe(17000);
		expect(unionDuration([])).toBeNull();
		const value = buildEfficiencyReport({
			objectives: [],
			timing: {
				version: 1,
				spans: [
					{ taskId: "dev1", category: "agent_running", start: 0, end: 10000 },
					{ taskId: "qa1", category: "agent_running", start: 0, end: 10000 },
					{ taskId: "dev1", category: "checks_running", start: 0, end: 10000 },
				],
				agentSamples: [{ taskId: "dev1", start: 0, end: 10000, ms: 6000 }],
				last: null,
				gaps: 0,
			},
			taskIds: new Set(["dev1", "qa1"]),
			now: 10000,
			scope: "project",
		});
		expect(value.observedElapsedMs).toBe(10000);
		expect(value.summedSampledMs).toBe(30000);
		expect(value.observedAgentRunningMs).toBe(6000);
		expect(value.totalEstimatedUsd).toBeNull();
	});
	it("keeps request versions/copies de-duplicated, conservative pricing and highest observed tokens without inventing total spend", () => {
		const first = objective();
		first.usage = [usage(2, "d", 100), usage(null, "e", 120), usage(1, "f", 80)];
		const copy = objective();
		copy.id = "obj-00000000-0000-4000-8000-000000000002";
		copy.usage = [usage(2, "d", 100)];
		const report = buildEfficiencyReport({
			objectives: [first, copy],
			timing: { version: 1, spans: [], agentSamples: [], last: null, gaps: 0 },
			taskIds: new Set(["dev1", "qa1"]),
			now: 30000,
			scope: "project",
		});
		expect(report.observedEstimatedUsd).toBe(2);
		expect(report.components[0]?.observedTokens?.input).toBe(120);
		expect(report.priceRevisions).toEqual(["c".repeat(64)]);
		expect(report.forecast).toBe("insufficient_evidence");
		expect(report.totalEstimatedUsd).toBeNull();
	});
	it("keeps absent telemetry unknown and excludes observations before a family's explicit attachment", () => {
		const source = objective();
		source.usage = [usage(2, "d")];
		const report = buildEfficiencyReport({
			objectives: [source],
			timing: { version: 1, spans: [], agentSamples: [], last: null, gaps: 1 },
			taskIds: new Set(["dev1"]),
			attachedAfter: new Map([["dev1", 20000]]),
			scope: "objective",
			now: 30000,
		});
		expect(report.observedEstimatedUsd).toBeNull();
		expect(report.observedAgentRunningMs).toBeNull();
		expect(report.warnings).toContain("usage_before_or_without_family_attribution_excluded");
		expect(report.warnings).toContain("restart_or_sampling_gaps_not_charged_as_active_time");
	});
	it("samples idempotently, retains native counter deltas and skips restart/long gaps without counting downtime", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const store = createEfficiencyTimingStore(homePath),
				labels = { dev1: ["agent_running" as const, "checks_running" as const] };
			await store.sample("demo", { serverId: "one", at: 1000, labels, counters: { dev1: 100 } });
			await store.sample("demo", { serverId: "one", at: 11000, labels, counters: { dev1: 10100 } });
			await store.sample("demo", { serverId: "one", at: 11000, labels, counters: { dev1: 10100 } });
			let state = await store.read("demo");
			expect(state.spans).toHaveLength(2);
			expect(state.agentSamples.map((sample) => sample.ms)).toEqual([10000]);
			await store.sample("demo", { serverId: "two", at: 100000, labels, counters: { dev1: 20000 } });
			state = await store.read("demo");
			expect(state.gaps).toBe(1);
			expect(state.agentSamples).toHaveLength(1);
			await store.sample("demo", { serverId: "two", at: 110000, labels, counters: { dev1: 25000 } });
			expect((await store.read("demo")).agentSamples.map((sample) => sample.ms)).toEqual([10000, 5000]);
			const path = getEfficiencyStatePath("demo", homePath);
			await writeFile(path, "");
			await expect(store.sample("demo", { serverId: "three", at: 120000, labels, counters: {} })).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe("");
		}));
	it("authorizes before reads, supports recorded plan descendants and never starts/reconciles work for a report", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const source = objective(),
				read = vi.fn(async () => ({ version: 1 as const, revision: 1, objectives: [source], receipts: [] }));
			const api = createEfficiencyApi({
				objectives: { read },
				plans: { read: async () => ({ version: 1, plans: {} }) },
				contexts: { bindings: async () => [] },
				timing: createEfficiencyTimingStore(homePath),
				board: async () => createBoard({ backlog: [createCard({ id: "dev1" })] }),
				now: () => 30000,
			});
			await expect(api.report({ kind: "unknown", reason: "fixture" }, "demo", {})).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(read).not.toHaveBeenCalled();
			const report = await api.report({ kind: "user" }, "demo", {});
			expect(report.authority).toBe("report_only_not_acceptance_or_billing");
			expect(report.observedEstimatedUsd).toBeNull();
			expect(report.taskCount).toBe(2);
		}));
});
