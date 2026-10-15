import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPipelineStateStore } from "../../../src/pipeline/pipeline-state";
import { createProviderUsageHolds } from "../../../src/pipeline/provider-usage-holds";
import { readLegacyProviderUsageHolds } from "../../../src/pipeline/provider-usage-holds-legacy";
import { qaGateEntrySchema } from "../../../src/pipeline/qa-gate";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

describe("durable provider quota holds", () => {
	it("imports the most conservative absolute reset from every project's QA history before the first project is evaluated", async () => {
		await withTemporaryKanbanHome(async () => {
			const state = createPipelineStateStore();
			for (const [workspace, resetAt] of [
				["earlier", 9000],
				["later", 8000],
			] as const) {
				await state.update(workspace, (current) => ({
					...current,
					cards: {
						dev: {
							qaAgentErrors: [
								{
									qaTaskId: "qa",
									snapshot: "snap",
									round: 1,
									at: 100,
									kind: "usage_limit",
									text: "limit",
									resetAt,
								},
							],
						},
						qa: {
							qaGate: qaGateEntrySchema.parse({
								reviewsTaskId: "dev",
								round: 1,
								snapshot: "snap",
								snapshotRef: "ref",
								outboxDir: "out",
								scratchDir: "scratch",
								baseRef: "main",
								agentId: "any-agent",
								model: { provider: "subscription", model: "any-model" },
								devAgentId: "any-agent",
								devModel: null,
								route: null,
								status: "superseded",
								createdAt: 0,
							}),
						},
					},
				}));
			}
			const holds = createProviderUsageHolds({ readLegacy: readLegacyProviderUsageHolds });
			await holds.ready();
			expect(holds.until("subscription", 1000)).toBe(9000 + 60_000);
			await expect(holds.record("subscription", 8000)).resolves.toBe(9000 + 60_000);
		});
	});
	const roots: ReturnType<typeof createTempDir>[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) root.cleanup();
	});
	const path = () => {
		const root = createTempDir("kanban-quota-holds-");
		roots.push(root);
		return join(root.path, "holds.json");
	};
	it("restores the absolute hold before use and preserves the later deadline when relative limits round down", async () => {
		const file = path();
		const first = createProviderUsageHolds({ path: file });
		await first.record("subscription", 5000);
		const restarted = createProviderUsageHolds({ path: file });
		await restarted.ready();
		expect(restarted.until("subscription", 1000)).toBe(5000);
		expect(await restarted.record("subscription", 4000)).toBe(5000);
		expect(restarted.until("subscription", 5000)).toBeNull();
	});
	it("imports earlier QA records before writing a new, shorter reset and merges concurrent recorders", async () => {
		const file = path();
		const first = createProviderUsageHolds({ path: file, readLegacy: async () => ({ subscription: 9000 }) });
		await first.ready();
		const second = createProviderUsageHolds({ path: file });
		await second.ready();
		await Promise.all([first.record("subscription", 7000), second.record("other", 8000)]);
		const loaded = createProviderUsageHolds({ path: file });
		await loaded.ready();
		expect(loaded.until("subscription", 1000)).toBe(9000);
		expect(loaded.until("other", 1000)).toBe(8000);
	});
	it("refuses to overwrite damaged holds or start as if they were empty, and can retry after repair", async () => {
		const file = path();
		writeFileSync(file, "truncated");
		const store = createProviderUsageHolds({ path: file });
		await expect(store.ready()).rejects.toThrow("Could not read provider quota holds");
		expect(readFileSync(file, "utf8")).toBe("truncated");
		writeFileSync(file, JSON.stringify({ version: 1, holds: { subscription: 5000 } }));
		await store.ready();
		expect(store.until("subscription", 1000)).toBe(5000);
	});
});
