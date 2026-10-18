import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentUsageObservation } from "../../../src/core/agent-usage-observation";
import { objectiveCreateSchema } from "../../../src/core/objective-contract";
import { createPriceTable, priceTableFileSchema } from "../../../src/kits/team/bench/prices";
import { createObjectiveStore } from "../../../src/objectives/objective-store";
import { priceObjectiveObservation } from "../../../src/objectives/objective-usage";
import { createTempDir } from "../../utilities/temp-dir";

const T0 = Date.parse("2026-10-18T10:00:00Z");
const observation: AgentUsageObservation = {
	key: "cline:request",
	agent: "cline",
	basis: "request",
	at: T0 + 1500,
	model: "fixture-model",
	provider: "bedrock",
	tokens: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2 },
	uncertainty: [],
};
describe("objective usage is observed, attributed and never fabricated zero", () => {
	it("deduplicates rereads, retains source/price revisions and a subtotal, never claims full coverage", async () => {
		const temp = createTempDir("objective-priced-usage-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			const created = await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			await store.observe("foo", [
				{
					taskId: "dev01",
					startedAt: T0 + 1000,
					stateChangedAt: T0 + 1000,
					updatedAt: T0 + 1000,
					state: "running",
					live: true,
					settled: false,
				},
			]);
			const objective = (await store.read("foo")).objectives[0];
			if (!objective) throw new Error("No objective");
			const prices = createPriceTable(
				priceTableFileSchema.parse({
					prices: [{ pattern: "fixture-model", in: 1, out: 2, cacheRead: 0.1, cacheWrite: 1.25, source: "aws" }],
				}),
				"seed",
			);
			const row = priceObjectiveObservation({
				objective,
				taskId: "dev01",
				observation,
				prices,
				observedAt: new Date(T0 + 2000).toISOString(),
			});
			expect(row.price?.estimatedUsd).toBeCloseTo((10 + 10 + 2 + 2.5) / 1e6);
			expect(row.price?.revision).toMatch(/^[a-f0-9]{64}$/u);
			await store.recordUsage("foo", created.id, [row]);
			await store.recordUsage("foo", created.id, [{ ...row, observedAt: new Date(T0 + 3000).toISOString() }]);
			let state = (await createObjectiveStore({ home: temp.path }).read("foo")).objectives[0];
			expect(state?.usage).toHaveLength(1);
			expect(state?.estimatedUsd).toBeNull();
			expect(state?.costCoverage).toBe("partial");
			expect(state?.observedEstimatedUsd).toBe(row.price?.estimatedUsd);
			const gap = priceObjectiveObservation({
				objective,
				taskId: "dev01",
				observation: { ...observation, provider: null, uncertainty: ["provider_missing"] },
				prices,
				observedAt: new Date(T0 + 4000).toISOString(),
			});
			await store.recordUsage("foo", created.id, [gap]);
			state = (await store.read("foo")).objectives[0];
			expect(state?.usage).toHaveLength(2);
			expect(state?.observedEstimatedUsd).toBe(row.price?.estimatedUsd);
			expect(state?.estimatedUsd).toBeNull();
		} finally {
			temp.cleanup();
		}
	});
	it("unknown billing routes, copied pre-objective turns and mixed session totals are not priced as zero", async () => {
		const temp = createTempDir("objective-unknown-usage-");
		try {
			const store = createObjectiveStore({ home: temp.path, now: () => new Date(T0) });
			const objective = await store.create(
				"foo",
				objectiveCreateSchema.parse({
					requestId: randomUUID(),
					title: "Objective",
					requirements: "Acceptance",
					taskIds: ["dev01"],
				}),
			);
			const prices = createPriceTable(
				priceTableFileSchema.parse({
					prices: [{ pattern: ".*", in: 0, out: 0, cacheRead: 0, cacheWrite: 0, source: "aws" }],
				}),
				"seed",
			);
			for (const value of [
				{ ...observation, provider: null },
				{ ...observation, at: T0 - 1000 },
				{ ...observation, basis: "session_total" as const, model: null, uncertainty: ["mixed_model" as const] },
				{ ...observation, tokens: null, uncertainty: ["usage_missing" as const] },
			]) {
				const row = priceObjectiveObservation({
					objective,
					taskId: "dev01",
					observation: value,
					prices,
					observedAt: new Date(T0 + 2000).toISOString(),
				});
				expect(row.price).toBeNull();
				expect(row.uncertainty.length).toBeGreaterThan(0);
			}
		} finally {
			temp.cleanup();
		}
	});
});
