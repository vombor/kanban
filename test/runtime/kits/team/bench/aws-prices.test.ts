// Ported from archive/devteam-kit:test/aws-prices.test.cjs@a3a92b0e (same fixtures: one product per usagetype style).
import { describe, expect, it } from "vitest";

import {
	type AwsProductAttributes,
	buildPrices,
	classify,
	diffPrices,
	diffRows,
	entryPrices,
	type LoadedAwsOffer,
	modelIds,
	normalize,
	per1MFactor,
} from "../../../../../src/kits/team/bench/aws-prices";
import type { PriceEntry } from "../../../../../src/kits/team/bench/prices";

let skuCounter = 0;
function offer(code: string, items: Array<[AwsProductAttributes, string, number]>): LoadedAwsOffer {
	const products: Record<string, { attributes: AwsProductAttributes }> = {};
	const onDemand: Record<
		string,
		Record<string, { priceDimensions: Record<string, { unit: string; pricePerUnit: { USD: string } }> }>
	> = {};
	for (const [attrs, unit, usd] of items) {
		skuCounter += 1;
		const sku = `SKU${skuCounter}`;
		products[sku] = {
			attributes: { servicecode: code, location: "US West (Oregon)", regionCode: "us-west-2", ...attrs },
		};
		onDemand[sku] = {
			[`${sku}.T`]: { priceDimensions: { [`${sku}.T.D`]: { unit, pricePerUnit: { USD: String(usd) } } } },
		};
	}
	return {
		offerCode: code,
		offer: { offerCode: code, version: "20261005000000", products, terms: { OnDemand: onDemand } },
	};
}

const kimi = { model: "Kimi K3", provider: "Moonshot AI" };
const bedrock = offer("AmazonBedrock", [
	// mantle style: Bedrock id in the usagetype, per 1K tokens
	[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-input-tokens-standard", ...kimi }, "1K tokens", 0.0033],
	[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-output-tokens-standard", ...kimi }, "1K tokens", 0.0165],
	[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-cache-read-tokens-standard", ...kimi }, "1K tokens", 0.00033],
	[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-standard", ...kimi }, "1K tokens", 0.004125],
	[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-input-tokens-global-standard", ...kimi }, "1K tokens", 0.003],
	[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-output-tokens-global-standard", ...kimi }, "1K tokens", 0.015],
	[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-input-tokens-global-flex", ...kimi }, "1K tokens", 0.0015],
	// legacy style: display name only; the id comes from the mantle row with the same name
	[
		{
			usagetype: "USW2-mistral.mistral-large-3-675b-instruct-mantle-input-tokens-standard",
			model: "Mistral Large 3",
			provider: "Mistral",
		},
		"1K tokens",
		0.0005,
	],
	[
		{
			usagetype: "USW2-Mistral-Large-3-675b-Instruct-output-tokens",
			model: "Mistral Large 3",
			provider: "Mistral",
			inferenceType: "Output tokens",
		},
		"1K tokens",
		0.0015,
	],
	[
		{
			usagetype: "USW2-Mistral-Large-3-675b-Instruct-input-tokens-batch",
			model: "Mistral Large 3",
			provider: "Mistral",
		},
		"1K tokens",
		0.00025,
	],
	// legacy Nova: curated id, cross-region-global suffix, cache read/write
	[{ usagetype: "USW2-Nova2.0Lite-input-tokens", model: "Nova 2.0 Lite" }, "1K tokens", 0.00033],
	[{ usagetype: "USW2-Nova2.0Lite-output-tokens", model: "Nova 2.0 Lite" }, "1K tokens", 0.00275],
	[{ usagetype: "USW2-Nova2.0Lite-cache-read-input-token-count", model: "Nova 2.0 Lite" }, "1K tokens", 0.0000825],
	[
		{ usagetype: "USW2-Nova2.0Lite-input-tokens-priority-cross-region-global", model: "Nova 2.0 Lite" },
		"1K tokens",
		0.000525,
	],
	// skipped: non-token units, reserved capacity, non-text modality
	[{ usagetype: "USW2-Ray-V2-Medfps-HDRes", model: "Ray v2", provider: "Luma AI" }, "Second", 1.5],
	[{ usagetype: "USW2-Nova2.0Omni-input-audio-token-count", model: "Nova 2.0 Omni" }, "1K tokens", 0.001],
]);
const opus = { servicename: "Claude Opus 5.5 (Amazon Bedrock Edition)" };
const haiku = { servicename: "Claude Haiku 4.5 (Amazon Bedrock Edition)" };
const astra = { servicename: "OpenAI GPT-6 Astra (Amazon Bedrock Edition)" };
const marketplace = offer("AmazonBedrockFoundationModels", [
	[{ usagetype: "USW2-MP:USW2_input_tokens_standard-Units", ...opus }, "1M tokens", 4.4],
	[{ usagetype: "USW2-MP:USW2_output_tokens_standard-Units", ...opus }, "1M tokens", 22],
	[{ usagetype: "USW2-MP:USW2_cache_write_tokens_1h_standard-Units", ...opus }, "1M tokens", 8.8],
	[{ usagetype: "USW2-MP:USW2_cache_write_tokens_standard-Units", ...opus }, "1M tokens", 5.5],
	[{ usagetype: "USW2-MP:USW2_InputTokenCount_Global-Units", ...haiku }, "1M tokens", 1],
	[{ usagetype: "USW2-MP:USW2_InputTokenCount-Units", ...haiku }, "1M tokens", 1.1],
	[{ usagetype: "USW2-MP:USW2_OutputTokenCount-Units", ...haiku }, "1M tokens", 5.5],
	[{ usagetype: "USW2-MP:USW2_CacheWrite1hInputTokenCount-Units", ...haiku }, "1M tokens", 2.2],
	[{ usagetype: "USW2-MP:USW2_Reserved_1Month_InputTPM_Geo-Units", ...haiku }, "1M TPM Hour", 0.066],
	[{ usagetype: "USW2-MP:USW2_input_tokens_long_ctx_standard-Units", ...astra }, "1M tokens", 22],
	[{ usagetype: "USW2-MP:USW2_output_tokens_long_ctx_standard-Units", ...astra }, "1M tokens", 82.5],
	[{ usagetype: "USW2-MP:USW2_input_tokens_standard-Units", ...astra }, "1M tokens", 11],
	[{ usagetype: "USW2-MP:USW2_output_tokens_standard-Units", ...astra }, "1M tokens", 55],
]);

const { rows, conflicts } = normalize([bedrock, marketplace]);
const row = (id: string, tier: string, kind: string) =>
	rows.find((entry) => entry.modelId === id && entry.tier === tier && entry.kind === kind)?.usdPer1M;

describe("aws prices: classify", () => {
	it("names kind and tier for every usagetype style and skips non-token rows", () => {
		expect(classify("USW2-moonshotai.kimi-k3-mantle-input-tokens-global-flex")).toEqual({
			kind: "input",
			global: true,
			longCtx: false,
			service: "flex",
			tier: "global_flex",
		});
		expect(classify("USW2-MP:USW2_cache_write_tokens_1h_standard-Units")?.kind).toBe("cacheWrite1h");
		expect(classify("USW2-MP:USW2_CacheWrite1hInputTokenCount_Global-Units")?.tier).toBe("global");
		expect(classify("USW2-MP:USW2_CacheWrite1hInputTokenCount_Global-Units")?.kind).toBe("cacheWrite1h");
		expect(classify("USW2-Nova2.0Lite-cache-write-input-token-count-flex")?.kind).toBe("cacheWrite5m");
		expect(classify("USW2-MP:USW2_input_tokens_long_ctx_global_standard-Units")?.tier).toBe("long_ctx_global");
		expect(classify("USW2-MP:USW2_OutputTokenCount_LatencyOptimized-Units")?.tier).toBe("latency");
		expect(classify("USW2-MP:USW2_Reserved_1Month_InputTPM_Geo-Units")).toBeNull();
		expect(per1MFactor("1K tokens")).toBe(1000);
		expect(per1MFactor("1M tokens")).toBe(1);
		expect(per1MFactor("1M TPM Hour")).toBeNull();
	});
});

describe("aws prices: normalize", () => {
	it("maps every offer style to Bedrock ids and $ per 1M tokens", () => {
		expect(conflicts).toEqual([]);
		expect(modelIds(rows).sort()).toEqual([
			"amazon.nova-2-lite-v1:0",
			"anthropic.claude-haiku-4-5",
			"anthropic.claude-opus-5-5",
			"mistral.mistral-large-3-675b-instruct",
			"moonshotai.kimi-k3",
			"openai.gpt-6-astra",
		]);
		expect(row("moonshotai.kimi-k3", "standard", "input")).toBe(3.3);
		expect(row("moonshotai.kimi-k3", "standard", "cacheWrite30m")).toBe(4.125);
		expect(row("moonshotai.kimi-k3", "global_flex", "input")).toBe(1.5);
		// The legacy row is mapped via the mantle display name.
		expect(row("mistral.mistral-large-3-675b-instruct", "standard", "output")).toBe(1.5);
		expect(row("mistral.mistral-large-3-675b-instruct", "batch", "input")).toBe(0.25);
		expect(row("amazon.nova-2-lite-v1:0", "global_priority", "input")).toBe(0.525);
		expect(row("anthropic.claude-opus-5-5", "standard", "cacheWrite1h")).toBe(8.8);
		expect(row("anthropic.claude-opus-5-5", "standard", "cacheWrite5m")).toBe(5.5);
		expect(row("openai.gpt-6-astra", "long_ctx", "input")).toBe(22);
		expect(rows.some((entry) => entry.modelId.includes("omni") || entry.modelId.includes("ray"))).toBe(false);
	});

	it("keeps the higher of two conflicting prices and reports it", () => {
		const duplicate = offer("AmazonBedrock", [
			[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-input-tokens-standard", ...kimi }, "1K tokens", 0.0033],
			[{ usagetype: "USW2-moonshotai.kimi-k3-mantle-input-tokens-standard-v2", ...kimi }, "1K tokens", 0.004],
		]);
		const result = normalize([duplicate]);
		expect(result.rows.find((entry) => entry.kind === "input")?.usdPer1M).toBe(4);
		expect(result.conflicts).toHaveLength(1);
	});
});

describe("aws prices: price table entries", () => {
	it("falls back to the input price for missing cache prices and uses the 30m write when there is no 5m one", () => {
		expect(entryPrices(rows, "moonshotai.kimi-k3")).toEqual({
			in: 3.3,
			cacheRead: 0.33,
			cacheWrite: 4.125,
			out: 16.5,
		});
		expect(entryPrices(rows, "mistral.mistral-large-3-675b-instruct")).toEqual({
			in: 0.5,
			cacheRead: 0.5,
			cacheWrite: 0.5,
			out: 1.5,
		});
		expect(entryPrices(rows, "openai.gpt-6-astra")?.long).toEqual({
			in: 22,
			cacheRead: 22,
			cacheWrite: 22,
			out: 82.5,
		});
		// No global output price → no global entry.
		expect(entryPrices(rows, "anthropic.claude-haiku-4-5", "global")).toBeNull();
	});

	const old: PriceEntry[] = [
		{ pattern: "kimi-k3", in: 9, cacheRead: 9, cacheWrite: 9, out: 9 },
		{ pattern: "mistral-large-3", in: 2, cacheRead: 2, cacheWrite: 2, out: 6, note: "PLACEHOLDER" },
		{ pattern: "gpt-6-luna", in: 0.11, cacheRead: 0.011, cacheWrite: 0.1375, out: 0.55 },
		{ pattern: "claude-haiku-4-5", in: 1, cacheRead: 0.1, cacheWrite: 1.25, out: 5, pin: true },
		{ pattern: "gpt-6-astra", in: 1, cacheRead: 1, cacheWrite: 1, out: 1, longOver: 272000 },
	];
	const kitModels = ["us.anthropic.claude-opus-5-5", "us.moonshotai.kimi-k3", "us.openai.gpt-6-luna"];
	const { prices, report } = buildPrices(old, rows, kitModels, { versions: { AmazonBedrock: "V1" } });
	const by = (pattern: string) => prices.find((entry) => entry.pattern === pattern);

	it("replaces hand values with AWS ones, keeps unlisted models manual, never touches pins, adds kit models", () => {
		expect(prices[0]?.pattern).toBe("claude-opus-5-5");
		expect(by("claude-opus-5-5")?.awsModel).toBe("anthropic.claude-opus-5-5");
		expect(by("claude-opus-5-5")?.cacheWrite).toBe(5.5);
		expect(by("kimi-k3")?.in).toBe(3.3);
		expect(by("kimi-k3")?.source).toBe("aws");
		expect(by("kimi-k3")?.note).toMatch(/AmazonBedrock V1 us-west-2, standard/u);
		const global = by("^global\\..*(?:kimi-k3)");
		expect(global?.in).toBe(3);
		expect(prices.indexOf(global as PriceEntry)).toBeLessThan(prices.indexOf(by("kimi-k3") as PriceEntry));
		expect(new RegExp(global?.pattern ?? "").test("global.moonshotai.kimi-k3")).toBe(true);
		expect(new RegExp(global?.pattern ?? "").test("us.moonshotai.kimi-k3")).toBe(false);
		expect(by("mistral-large-3")?.out).toBe(1.5);
		expect(by("gpt-6-luna")?.source).toBe("manual");
		expect(by("gpt-6-luna")?.in).toBe(0.11);
		expect(by("claude-haiku-4-5")).toEqual(old[3]);
		expect(by("gpt-6-astra")?.longOver).toBe(272000);
		expect(by("gpt-6-astra")?.long?.out).toBe(82.5);
		expect(report.unpriced).toEqual([]);
		expect(report.manual.map((entry) => entry.pattern).sort()).toEqual(["claude-haiku-4-5", "gpt-6-luna"]);
	});

	it("diffs tables and rows, and regenerating is idempotent", () => {
		const diff = diffPrices(old, prices);
		expect(diff.some((line) => line.startsWith("~ mistral-large-3 (WAS MANUAL): in 2 → 0.5"))).toBe(true);
		expect(diff.some((line) => line.startsWith("+ claude-opus-5-5: in 4.4"))).toBe(true);
		expect(diff).toContain("~ gpt-6-luna: source (none) → manual");
		expect(diffPrices(prices, prices)).toEqual([]);
		const again = buildPrices(prices, rows, ["us.anthropic.claude-opus-5-5"], { versions: { AmazonBedrock: "V1" } });
		expect(diffPrices(prices, again.prices)).toEqual([]);

		const bumped = rows.map((entry) =>
			entry.modelId === "moonshotai.kimi-k3" && entry.tier === "standard" && entry.kind === "output"
				? { ...entry, usdPer1M: 18 }
				: entry,
		);
		const rowDiff = diffRows(
			rows,
			bumped.filter((entry) => entry.modelId !== "openai.gpt-6-astra"),
		);
		expect(rowDiff.changed).toHaveLength(1);
		expect(rowDiff.changed[0]?.from).toBe(16.5);
		expect(rowDiff.removed).toHaveLength(rows.filter((entry) => entry.modelId === "openai.gpt-6-astra").length);
		expect(rowDiff.added).toHaveLength(0);
	});
});
