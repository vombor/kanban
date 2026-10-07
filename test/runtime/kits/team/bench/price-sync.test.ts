import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getBuiltInKits, getDefaultKit } from "../../../../../src/kits/resolve-kit";
import { createBenchFeature } from "../../../../../src/kits/team/bench/bench-feature";
import {
	AWS_PRICE_LIST_HOST,
	insertPriceAttentionLine,
	type PriceSyncOptions,
	runPriceSync,
} from "../../../../../src/kits/team/bench/price-sync";
import { createPriceCheckJob, listKitModels } from "../../../../../src/kits/team/bench/price-sync-job";
import type { PriceTableFile } from "../../../../../src/kits/team/bench/prices";
import { createPipelineEventBus } from "../../../../../src/pipeline/events";
import { createPipelineFeatureRegistry } from "../../../../../src/pipeline/features";
import { getPricesDataPaths, type PricesDataPaths } from "../../../../../src/state/kanban-home";
import { createTempDir } from "../../../../utilities/temp-dir";

type Offer = { products: Record<string, unknown>; terms: { OnDemand: Record<string, unknown> } };

function bedrockOffer(kimiOutputPer1K: number): Offer {
	const items: Array<[string, number]> = [
		["USW2-moonshotai.kimi-k3-mantle-input-tokens-standard", 0.0033],
		["USW2-moonshotai.kimi-k3-mantle-output-tokens-standard", kimiOutputPer1K],
		["USW2-zai.glm-5-mantle-input-tokens-standard", 0.001],
		["USW2-zai.glm-5-mantle-output-tokens-standard", 0.003],
	];
	const products: Record<string, unknown> = {};
	const onDemand: Record<string, unknown> = {};
	items.forEach(([usagetype, usd], index) => {
		const sku = `S${index}`;
		products[sku] = { attributes: { usagetype, model: usagetype.split("-mantle")[0] } };
		onDemand[sku] = {
			[`${sku}.T`]: { priceDimensions: { D: { unit: "1K tokens", pricePerUnit: { USD: String(usd) } } } },
		};
	});
	return { products, terms: { OnDemand: onDemand } };
}

const emptyOffer: Offer = { products: {}, terms: { OnDemand: {} } };

function fakeAws(versions: Record<string, string>, offers: Record<string, Offer>) {
	const fetchText = vi.fn(async (url: string) => {
		for (const code of Object.keys(versions)) {
			if (url === `${AWS_PRICE_LIST_HOST}/offers/v1.0/aws/${code}/current/region_index.json`) {
				return JSON.stringify({
					regions: {
						"us-west-2": { currentVersionUrl: `/offers/v1.0/aws/${code}/${versions[code]}/us-west-2/index.json` },
					},
				});
			}
			if (url === `${AWS_PRICE_LIST_HOST}/offers/v1.0/aws/${code}/${versions[code]}/us-west-2/index.json`) {
				return JSON.stringify(offers[code] ?? emptyOffer);
			}
		}
		throw new Error(`unexpected ${url}`);
	});
	return fetchText;
}

const VERSIONS_1 = { AmazonBedrock: "V1", AmazonBedrockFoundationModels: "F1", AmazonBedrockService: "S1" };
const VERSIONS_2 = { ...VERSIONS_1, AmazonBedrock: "V2" };

const baseTable: PriceTableFile = {
	prices: [
		{ pattern: "kimi-k3", in: 9, cacheRead: 9, cacheWrite: 9, out: 9 },
		{ pattern: "gpt-6-luna", in: 0.11, cacheRead: 0.011, cacheWrite: 0.1375, out: 0.55 },
	],
};

let home: { path: string; cleanup: () => void };
let paths: PricesDataPaths;
let attention: string;

function options(overrides: Partial<PriceSyncOptions>): PriceSyncOptions {
	return {
		mode: "dry-run",
		region: "us-west-2",
		paths,
		baseTable,
		baseTableSource: "seed",
		kitModels: [],
		attentionFiles: [attention],
		fetchText: fakeAws(VERSIONS_1, { AmazonBedrock: bedrockOffer(0.0165) }),
		now: () => new Date("2026-10-07T06:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	home = createTempDir("price-sync-");
	paths = getPricesDataPaths(home.path);
	attention = join(home.path, "data", "foo", "ATTENTION.md");
});

afterEach(() => {
	home.cleanup();
});

describe("price sync", () => {
	it("dry run: caches the offers, writes prices-aws.json, proposes the table and writes no prices.json", async () => {
		const result = await runPriceSync(options({ kitModels: ["us.zai.glm-5"] }));
		expect(result.applied).toBe(false);
		expect(result.versions).toEqual(VERSIONS_1);
		expect(existsSync(paths.pricesJson)).toBe(false);
		const aws = JSON.parse(readFileSync(paths.pricesAwsJson, "utf8")) as { rows: unknown[]; region: string };
		expect(aws.region).toBe("us-west-2");
		expect(aws.rows).toHaveLength(4);
		expect(result.pending).toContain(
			"~ kimi-k3 (WAS MANUAL): in 9 → 3.3; cacheRead 9 → 3.3; cacheWrite 9 → 3.3; out 9 → 16.5; source (none) → aws",
		);
		expect(result.pending.some((line) => line.startsWith("+ glm-5:"))).toBe(true);
		expect(result.lines).toContain("  manual  gpt-6-luna: not in the AWS Price List");
		expect(readFileSync(paths.log, "utf8")).toMatch(/baseline: 4 rows/u);
		// First run is the baseline: nothing to report.
		expect(result.changeLine).toBeNull();
		expect(existsSync(attention)).toBe(false);
	});

	it("--apply writes prices.json; the next run sees it in sync and downloads nothing new", async () => {
		const fetchText = fakeAws(VERSIONS_1, { AmazonBedrock: bedrockOffer(0.0165) });
		const applied = await runPriceSync(options({ mode: "apply", fetchText }));
		expect(applied.applied).toBe(true);
		const table = JSON.parse(readFileSync(paths.pricesJson, "utf8")) as PriceTableFile;
		expect(table.prices.find((entry) => entry.pattern === "kimi-k3")).toMatchObject({
			in: 3.3,
			out: 16.5,
			source: "aws",
		});
		const downloads = fetchText.mock.calls.length;

		const again = await runPriceSync(options({ fetchText }));
		expect(again.pending).toEqual([]);
		expect(again.lines.at(-1)).toBe("prices.json: in sync with AWS");
		// Only the three region indexes again: the offer files were cached by version.
		expect(fetchText.mock.calls.length - downloads).toBe(3);
	});

	it("--check: a price change of one of our models goes to ATTENTION.md and the log; no table is written", async () => {
		await runPriceSync(options({ mode: "check" }));
		expect(existsSync(paths.pricesAwsJson)).toBe(false);
		const changed = await runPriceSync(
			options({
				mode: "check",
				fetchText: fakeAws(VERSIONS_2, { AmazonBedrock: bedrockOffer(0.018) }),
				now: () => new Date("2026-10-08T06:00:00Z"),
			}),
		);
		expect(changed.changeLine).toMatch(
			/^- 2026-10-08 06:00Z: AWS Bedrock prices changed \(AmazonBedrock V1 → V2\): kimi-k3 standard output 16\.5 → 18\./u,
		);
		expect(readFileSync(attention, "utf8")).toContain(`## Prices (info)\n${changed.changeLine}`);
		expect(readFileSync(paths.log, "utf8")).toMatch(/check done: 4 rows; prices.json 2 pending/u);
		expect(existsSync(paths.pricesJson)).toBe(false);
		expect(existsSync(paths.pricesAwsJson)).toBe(false);
		const state = JSON.parse(readFileSync(paths.state, "utf8")) as {
			lastCheckAt: string;
			offers: Record<string, { version: string }>;
		};
		expect(state.lastCheckAt).toBe("2026-10-08T06:00:00.000Z");
		expect(state.offers.AmazonBedrock?.version).toBe("V2");
	});

	it("a change of a model we don't price is logged but not put in ATTENTION.md", async () => {
		const table: PriceTableFile = { prices: [{ pattern: "gpt-6-luna", in: 1, cacheRead: 1, cacheWrite: 1, out: 1 }] };
		await runPriceSync(options({ mode: "check", baseTable: table }));
		const changed = await runPriceSync(
			options({
				mode: "check",
				baseTable: table,
				fetchText: fakeAws(VERSIONS_2, { AmazonBedrock: bedrockOffer(0.018) }),
			}),
		);
		expect(changed.changeLine).toBeNull();
		expect(changed.lines[0]).toMatch(/none of our models changed\. 1 other price\(s\) changed/u);
		expect(existsSync(attention)).toBe(false);
	});

	it("--offline uses the cache and fails clearly without one; a failure is logged", async () => {
		await expect(runPriceSync(options({ offline: true }))).rejects.toThrow(/nothing cached/u);
		expect(readFileSync(paths.log, "utf8")).toMatch(/FAILED: AmazonBedrock: nothing cached/u);
		await runPriceSync(options({}));
		const fetchText = vi.fn(async () => {
			throw new Error("network is off");
		});
		await expect(runPriceSync(options({ offline: true, fetchText }))).resolves.toMatchObject({ rows: 4 });
		expect(fetchText).not.toHaveBeenCalled();
	});

	it("refuses to compare against an invalid prices.json instead of overwriting it", async () => {
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.pricesJson, JSON.stringify({ prices: [{ pattern: "x" }] }));
		await expect(runPriceSync(options({ mode: "apply" }))).rejects.toThrow(/not a valid price table/u);
		expect(readFileSync(paths.pricesJson, "utf8")).toBe(JSON.stringify({ prices: [{ pattern: "x" }] }));
	});
});

describe("price ATTENTION.md section", () => {
	it("goes after the orchestrator's section, newest first, and keeps 5 lines", () => {
		const first = insertPriceAttentionLine("# Attention\n- a card\n", "- p1");
		expect(first).toBe("# Attention\n- a card\n\n## Orchestrator: needs the user\n\n## Prices (info)\n- p1\n");
		let text = first;
		for (const line of ["- p2", "- p3", "- p4", "- p5", "- p6"]) {
			text = insertPriceAttentionLine(text, line);
		}
		expect(text.split("## Prices (info)\n")[1]).toBe("- p6\n- p5\n- p4\n- p3\n- p2\n");
		const withTail = insertPriceAttentionLine(
			"## Orchestrator: needs the user\n- x\n\n## Prices (info)\n- old\n\n## Other\n- y\n",
			"- new",
		);
		expect(withTail).toBe(
			"## Orchestrator: needs the user\n- x\n\n## Prices (info)\n- new\n- old\n\n## Other\n- y\n",
		);
	});
});

describe("daily price check job", () => {
	it("runs the check at most once a day, and not at all when autoSync is off", async () => {
		const sync = vi.fn(async () => ({
			lines: [],
			changeLine: null,
			pending: [],
			rows: 4,
			versions: {},
			applied: false,
		}));
		let now = new Date("2026-10-07T06:00:00Z");
		const context = {
			workspaceIds: ["foo"],
			region: "us-west-2",
			kitModels: [],
			attentionFiles: [attention],
			autoSync: true,
		};
		const job = createPriceCheckJob({ readContext: async () => context, paths, sync, now: () => now });
		expect(job).toMatchObject({ name: "prices-check", everyMin: 1440 });
		expect(await job.run()).toBe("4 rows; prices.json in sync");
		expect(sync).toHaveBeenCalledWith(expect.objectContaining({ mode: "check", attentionFiles: [attention] }));

		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.state, JSON.stringify({ offers: {}, lastCheckAt: "2026-10-07T06:00:00Z" }));
		now = new Date("2026-10-07T20:00:00Z");
		expect(await job.run()).toBe("skipped: checked at 2026-10-07T06:00:00.000Z");
		now = new Date("2026-10-08T06:00:00Z");
		await job.run();
		expect(sync).toHaveBeenCalledTimes(2);

		const off = createPriceCheckJob({ readContext: async () => ({ ...context, autoSync: false }), paths, sync });
		expect(await off.run()).toBe("skipped: prices.autoSync is off");
		expect(sync).toHaveBeenCalledTimes(2);
	});

	it("is registered as the bench feature's job, only on workspaces whose kit lists bench", async () => {
		const registry = createPipelineFeatureRegistry({ bus: createPipelineEventBus() });
		const readContext = vi.fn(async () => ({
			workspaceIds: ["foo"],
			region: "us-west-2",
			kitModels: [],
			attentionFiles: [],
			autoSync: false,
		}));
		registry.register(createBenchFeature({ readContext, paths }));
		const team = getBuiltInKits().get("team");
		if (!team) {
			throw new Error("team kit missing");
		}
		registry.syncWorkspace("foo", team);
		registry.syncWorkspace("kanban-2uge", getDefaultKit());
		const jobs = registry.listJobs("foo");
		expect(jobs.map((job) => [job.name, job.everyMin])).toEqual([["bench:prices-check", 1440]]);
		expect(registry.listJobs("kanban-2uge")).toEqual([]);
		expect(await jobs[0]?.run()).toBe("skipped: prices.autoSync is off");
	});

	it("takes its models from the kit's tiers and dropped list", () => {
		const team = getBuiltInKits().get("team");
		if (!team) {
			throw new Error("team kit missing");
		}
		const models = listKitModels(team);
		expect(models.length).toBeGreaterThan(0);
		expect(new Set(models).size).toBe(models.length);
		for (const entry of team.dropped ?? []) {
			expect(models).toContain(entry.model);
		}
	});
});
