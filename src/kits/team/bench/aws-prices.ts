// AWS Price List (bulk API) → normalized Bedrock token prices, and price-table entries from them. Pure functions only
// (no network, no files), so the tests run them on fixtures. The team kit's `bench` feature (plan §2.4).
//
// Ported from archive/devteam-kit:lib/aws-prices.cjs@a3a92b0e.
//
// Offers read (one region file each, us-west-2 by default; see price-sync.ts):
//   AmazonBedrock                 open-weight + Amazon + some third-party models. Prices per 1K tokens.
//                                 Two usagetype styles: "USW2-<bedrock id>-mantle-<kind>-tokens[-30m][-global]-<tier>"
//                                 (the id is in the usagetype) and legacy "USW2-<Name>-<kind>-tokens[-flex][-cross-region-global]"
//                                 (only the display name in attributes.model).
//   AmazonBedrockFoundationModels Marketplace-billed models (Anthropic Claude, OpenAI GPT-6 Astra, Cohere, ...).
//                                 "USW2-MP:USW2_input_tokens[_long_ctx][_global]_standard-Units" or
//                                 "USW2-MP:USW2_InputTokenCount[_Global][_Batch]-Units"; per 1M tokens; the model is
//                                 only in attributes.servicename ("Claude Opus 5.5 (Amazon Bedrock Edition)").
//   AmazonBedrockService          a few Claude models billed by AWS itself ("USW2-Claude4Sonnet-input-tokens-cross-region-global").
// Row: { modelId, tier, kind, usdPer1M, offer, usagetype, global, longCtx, service }
//   kind:    input | output | cacheRead | cacheWrite5m | cacheWrite30m | cacheWrite1h
//   service: standard | flex | priority | batch | latency (latency-optimized)
//   tier:    one name for (longCtx, global, service): "standard", "global", "long_ctx", "flex", "batch", "priority",
//            and combinations joined by "_" in that order ("global_flex", "long_ctx_global", "global_batch").
// Reserved capacity (TPM-hour), provisioned throughput, images, video, requests, ... are skipped.
import type { PriceEntry, PriceRates } from "./prices";

export type AwsPriceKind = "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite30m" | "cacheWrite1h";
export type AwsPriceService = "standard" | "flex" | "priority" | "batch" | "latency";

export interface AwsPriceClass {
	kind: AwsPriceKind;
	global: boolean;
	longCtx: boolean;
	service: AwsPriceService;
	tier: string;
}

export interface AwsPriceRow {
	modelId: string;
	tier: string;
	kind: AwsPriceKind;
	usdPer1M: number;
	offer: string;
	usagetype: string;
	global?: boolean;
	longCtx?: boolean;
	service?: AwsPriceService;
	name?: string;
}

export interface AwsProductAttributes {
	usagetype?: string;
	model?: string;
	servicename?: string;
	provider?: string;
	feature?: string;
	[key: string]: string | undefined;
}

/** The parts of an AWS Price List offer file this module reads. */
export interface AwsOfferFile {
	offerCode?: string;
	version?: string;
	publicationDate?: string;
	products?: Record<string, { attributes?: AwsProductAttributes }>;
	terms?: {
		OnDemand?: Record<
			string,
			Record<string, { priceDimensions?: Record<string, { unit?: string; pricePerUnit?: { USD?: string } }> }>
		>;
	};
}

export interface LoadedAwsOffer {
	offerCode: string;
	offer: AwsOfferFile;
}

export interface AwsPriceConflict {
	key: string;
	prices: [number, number];
	usagetypes: [string, string];
}

const PROVIDER_PREFIX: Record<string, string> = {
	amazon: "amazon",
	anthropic: "anthropic",
	meta: "meta",
	mistral: "mistral",
	"mistral ai": "mistral",
	qwen: "qwen",
	deepseek: "deepseek",
	google: "google",
	"moonshot ai": "moonshotai",
	"kimi ai": "moonshotai",
	"minimax ai": "minimax",
	nvidia: "nvidia",
	openai: "openai",
	"z ai": "zai",
	writer: "writer",
	xai: "xai",
	cohere: "cohere",
	"ai21 labs": "ai21",
	"stability ai": "stability",
	"luma ai": "luma",
	twelvelabs: "twelvelabs",
};
// Display names whose Bedrock id doesn't follow from the name (checked against `aws bedrock list-foundation-models`
// ids the kit uses). Everything else: a mantle row with the same display name, else the slug rule in modelIdFor().
const KNOWN_IDS: Record<string, string> = {
	"Nova 2.0 Lite": "amazon.nova-2-lite-v1:0",
	"Nova 2.0 Pro": "amazon.nova-2-pro-v1:0",
	"Nova 2.0 Omni": "amazon.nova-2-omni-v1:0",
	"Nova Pro": "amazon.nova-pro-v1:0",
	"Nova Lite": "amazon.nova-lite-v1:0",
	"Nova Micro": "amazon.nova-micro-v1:0",
	"Nova Premier": "amazon.nova-premier-v1:0",
};

const MANTLE_ID = /^[A-Z0-9]+-([a-z0-9-]+\.[a-z0-9.:-]+?)-mantle-/u;
// Bare-name prefixes that tell the provider when the product has no `provider` attribute: [name test, provider,
// prefix stripped from the name].
const NAME_PROVIDERS: ReadonlyArray<[RegExp, string, RegExp | null]> = [
	[/^claude\b/iu, "anthropic", null],
	[/^openai\b/iu, "openai", /^openai\s+/iu],
	[/^(nova|titan)\b/iu, "amazon", null],
	[/^cohere\b/iu, "cohere", /^cohere\s+/iu],
	[/^meta\b/iu, "meta", /^meta\s+/iu],
	[/^jurassic\b/iu, "ai21 labs", null],
	[/^palmyra\b/iu, "writer", null],
	[/^twelvelabs\b/iu, "twelvelabs", /^twelvelabs\s+/iu],
];

const slug = (value: string): string =>
	value
		.replace(/\+/gu, " plus")
		.toLowerCase()
		.replace(/[^a-z0-9.]+/gu, "-")
		.replace(/^-|-$/gu, "");

/** Bedrock-style model id for a product, best effort. `mantleIds` maps display name → id seen in mantle usagetypes. */
export function modelIdFor(attrs: AwsProductAttributes, mantleIds: Record<string, string> = {}): string | null {
	const mantle = MANTLE_ID.exec(attrs.usagetype ?? "");
	if (mantle?.[1]) {
		return mantle[1];
	}
	let name = attrs.model || (attrs.servicename ?? "").replace(/\s*\(Amazon Bedrock Edition\)\s*$/u, "");
	if (!name || name === "Amazon Bedrock") {
		return null;
	}
	const known = KNOWN_IDS[name] ?? mantleIds[name];
	if (known) {
		return known;
	}
	if (/^[a-z0-9-]+\.[a-z0-9.:-]+$/u.test(name)) {
		return name; // already an id ("xai.grok-4.3", "google.gemma-4-31b")
	}
	let provider = (attrs.provider ?? "").toLowerCase();
	if (!provider) {
		for (const [test, providerName, strip] of NAME_PROVIDERS) {
			if (test.test(name)) {
				provider = providerName;
				if (strip) {
					name = name.replace(strip, "");
				}
				break;
			}
		}
	}
	const prefix = PROVIDER_PREFIX[provider] ?? slug(provider || "unknown");
	let id = slug(name);
	if (prefix === "anthropic") {
		id = id.replace(/(\d)\.(\d)/gu, "$1-$2"); // Claude ids use dashes: claude-opus-4-5
	}
	return `${prefix}.${id}`;
}

/** kind/tier from a usagetype (any of the styles above). Null for rows that aren't per-token prices. */
export function classify(usagetype: string): AwsPriceClass | null {
	const u = usagetype
		.replace(/^[A-Z0-9]+-(MP:[A-Z0-9]+_)?/u, "")
		.replace(/-Units$/u, "")
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()
		.replace(/_/gu, "-");
	if (/reserved|tpm|provisioned|model-unit|customization|storage|training/u.test(u)) {
		return null;
	}
	if (/(^|-)(image|audio|video|speech)(-|$)/u.test(u)) {
		return null; // non-text modalities (Nova Omni/Sonic): text prices only
	}
	let kind: AwsPriceKind | null = null;
	if (/cache-?read/u.test(u)) {
		kind = "cacheRead";
	} else if (/cache-?write/u.test(u)) {
		kind = /(^|-)1h(-|$)|write-?1h/u.test(u)
			? "cacheWrite1h"
			: /(^|-)30m(-|$)/u.test(u)
				? "cacheWrite30m"
				: "cacheWrite5m";
	} else if (/(^|-)input(-|$)/u.test(u)) {
		kind = "input";
	} else if (/(^|-)(output|response)(-|$)/u.test(u)) {
		kind = "output";
	}
	if (!kind) {
		return null;
	}
	const global = /(^|-)global(-|$)/u.test(u);
	const longCtx = /long-?ctx|long-context/u.test(u);
	const service: AwsPriceService = /(^|-)flex(-|$)/u.test(u)
		? "flex"
		: /(^|-)priority(-|$)/u.test(u)
			? "priority"
			: /(^|-)batch(-|$)/u.test(u)
				? "batch"
				: /latency-?optimized/u.test(u)
					? "latency"
					: "standard";
	const tier =
		[longCtx && "long_ctx", global && "global", service !== "standard" && service].filter(Boolean).join("_") ||
		"standard";
	return { kind, global, longCtx, service, tier };
}

/** "1K tokens" → 1000, "1M tokens" / "Million tokens" → 1; anything else (seconds, images, TPM hours) → null. */
export function per1MFactor(unit: string | undefined): number | null {
	const u = String(unit ?? "")
		.toLowerCase()
		.trim();
	if (/^1k tokens?$|^1,?000 tokens?$|^thousand tokens?$/u.test(u)) {
		return 1000;
	}
	if (/^1m tokens?$|^million tokens?$|^1,?000,?000 tokens?$/u.test(u)) {
		return 1;
	}
	if (/^tokens?$/u.test(u)) {
		return 1e6;
	}
	return null;
}

const roundPrice = (value: number): number => Math.round(value * 1e9) / 1e9;

/** One offer file → rows (not de-duplicated). */
export function normalizeOffer(offer: AwsOfferFile, offerCode = offer.offerCode ?? ""): AwsPriceRow[] {
	const products = offer.products ?? {};
	const onDemand = offer.terms?.OnDemand ?? {};
	const mantleIds: Record<string, string> = {};
	for (const product of Object.values(products)) {
		const attrs = product.attributes ?? {};
		const mantle = MANTLE_ID.exec(attrs.usagetype ?? "");
		if (mantle?.[1] && attrs.model) {
			mantleIds[attrs.model] = mantle[1];
		}
	}
	const rows: AwsPriceRow[] = [];
	for (const [sku, product] of Object.entries(products)) {
		const attrs = product.attributes ?? {};
		if (!attrs.usagetype || /reserved/iu.test(attrs.feature ?? "")) {
			continue;
		}
		const priceClass = classify(attrs.usagetype);
		if (!priceClass) {
			continue;
		}
		const modelId = modelIdFor(attrs, mantleIds);
		if (!modelId) {
			continue;
		}
		for (const term of Object.values(onDemand[sku] ?? {})) {
			for (const dimension of Object.values(term.priceDimensions ?? {})) {
				const factor = per1MFactor(dimension.unit);
				const usd = Number(dimension.pricePerUnit?.USD);
				if (!factor || !Number.isFinite(usd)) {
					continue;
				}
				rows.push({
					modelId,
					tier: priceClass.tier,
					kind: priceClass.kind,
					usdPer1M: roundPrice(usd * factor),
					offer: offerCode,
					usagetype: attrs.usagetype,
					global: priceClass.global,
					longCtx: priceClass.longCtx,
					service: priceClass.service,
					name: attrs.model || attrs.servicename || "",
				});
			}
		}
	}
	return rows;
}

const rowKey = (row: Pick<AwsPriceRow, "modelId" | "tier" | "kind">): string =>
	`${row.modelId}|${row.tier}|${row.kind}`;

/**
 * Conflicting prices for the same (modelId, tier, kind) keep the higher one (cost caps should trip early, not late)
 * and are reported in `conflicts`.
 */
export function dedupe(rows: AwsPriceRow[]): { rows: AwsPriceRow[]; conflicts: AwsPriceConflict[] } {
	const byKey = new Map<string, AwsPriceRow>();
	const conflicts: AwsPriceConflict[] = [];
	for (const row of rows) {
		const key = rowKey(row);
		const previous = byKey.get(key);
		if (!previous) {
			byKey.set(key, row);
			continue;
		}
		if (previous.usdPer1M !== row.usdPer1M) {
			conflicts.push({
				key,
				prices: [previous.usdPer1M, row.usdPer1M],
				usagetypes: [previous.usagetype, row.usagetype],
			});
			if (row.usdPer1M > previous.usdPer1M) {
				byKey.set(key, row);
			}
		}
	}
	const sorted = [...byKey.values()].sort(
		(a, b) => a.modelId.localeCompare(b.modelId) || a.tier.localeCompare(b.tier) || a.kind.localeCompare(b.kind),
	);
	return { rows: sorted, conflicts };
}

export function normalize(offers: LoadedAwsOffer[]): { rows: AwsPriceRow[]; conflicts: AwsPriceConflict[] } {
	return dedupe(offers.flatMap(({ offer, offerCode }) => normalizeOffer(offer, offerCode)));
}

/**
 * Prices for one model at one tier in the price table's shape. Missing cache prices fall back to the input price;
 * cacheWrite = the 5-minute write if listed, else the 30-minute one (OpenAI/Kimi style), else input. Null if there is
 * no input+output price at that tier.
 */
export function entryPrices(
	rows: AwsPriceRow[],
	modelId: string,
	tier = "standard",
): (PriceRates & { long?: PriceRates }) | null {
	const pick = (tierName: string): PriceRates | null => {
		const kinds = new Map(
			rows.filter((row) => row.modelId === modelId && row.tier === tierName).map((row) => [row.kind, row.usdPer1M]),
		);
		const input = kinds.get("input");
		const output = kinds.get("output");
		if (input === undefined || output === undefined) {
			return null;
		}
		return {
			in: input,
			cacheRead: kinds.get("cacheRead") ?? input,
			cacheWrite: kinds.get("cacheWrite5m") ?? kinds.get("cacheWrite30m") ?? input,
			out: output,
		};
	};
	const base = pick(tier);
	if (!base) {
		return null;
	}
	const long = pick(tier === "standard" ? "long_ctx" : `long_ctx_${tier}`);
	return long ? { ...base, long } : base;
}

export function modelIds(rows: AwsPriceRow[]): string[] {
	return [...new Set(rows.map((row) => row.modelId))];
}

/**
 * Strips the inference-profile prefix and the version suffix: "us.anthropic.claude-opus-5-5" → "claude-opus-5-5",
 * "us.amazon.nova-2-lite-v1:0" → "nova-2-lite".
 */
export function baseName(id: string): string {
	return id
		.replace(/^(us|eu|apac|global|us-gov)\./u, "")
		.replace(/^[a-z0-9-]+\./u, "")
		.replace(/(-\d{8})?-v\d+(:\d+)?$/u, "");
}

// ---- price table generation ------------------------------------------------------------------------------------
// Tier for our cards: they call us.* (geographic cross-region) inference profiles, which AWS bills at the source
// region's in-region rate = the Price List's "standard" / "Regional" rows. global.* profiles are the "global" rows
// (about 10% cheaper); they get their own "^global\." entry right before the standard one.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const PRICE_KEYS = ["in", "cacheRead", "cacheWrite", "out"] as const;
const DEFAULT_LONG_OVER: Record<string, number> = { openai: 272000, anthropic: 200000 };
const isGlobalEntry = (entry: PriceEntry): boolean => entry.source === "aws" && entry.tier === "global";

function tryRegExp(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern, "u");
	} catch {
		try {
			return new RegExp(pattern);
		} catch {
			return null;
		}
	}
}

/** AWS model ids a price-table pattern stands for. Patterns are written against card model ids (us.<id>), so both forms are tried. */
export function idsForPattern(pattern: string, ids: string[]): string[] {
	const re = tryRegExp(pattern);
	return re ? ids.filter((id) => re.test(id) || re.test(`us.${id}`)) : [];
}

/** A card/kit model id → the AWS id with the same base name ("us.anthropic.claude-opus-5-5" → anthropic.claude-opus-5-5). */
export function awsIdForModel(model: string, ids: string[]): string | null {
	const base = baseName(model);
	return ids.find((id) => baseName(id) === base) ?? null;
}

export interface PriceBuildMeta {
	versions?: Record<string, string>;
	region?: string;
}

function awsEntry(
	pattern: string,
	rows: AwsPriceRow[],
	id: string,
	tier: string,
	meta: PriceBuildMeta,
	old?: PriceEntry,
): PriceEntry | null {
	const prices = entryPrices(rows, id, tier);
	if (!prices) {
		return null;
	}
	const entry: PriceEntry = {
		pattern,
		in: prices.in,
		cacheRead: prices.cacheRead,
		cacheWrite: prices.cacheWrite,
		out: prices.out,
	};
	if (prices.long) {
		entry.longOver = old?.longOver ?? DEFAULT_LONG_OVER[id.split(".")[0] ?? ""] ?? 200000;
		entry.long = prices.long;
	}
	const offer = rows.find((row) => row.modelId === id && row.tier === tier)?.offer ?? "?";
	entry.source = "aws";
	entry.awsModel = id;
	entry.tier = tier;
	entry.note = `AWS Price List ${offer} ${meta.versions?.[offer] ?? "?"} ${meta.region ?? "us-west-2"}, ${tier}${tier === "standard" ? " (= us.* geo cross-region)" : " (global.* profiles)"}; generated by kanban models prices sync`;
	return entry;
}

export interface PriceBuildReport {
	mapped: Array<{ pattern: string; awsModel: string; wasManual: boolean }>;
	manual: Array<{ pattern: string; why: string }>;
	ambiguous: Array<{ pattern: string; ids: string[] }>;
	added: Array<{ pattern: string; awsModel: string; model: string }>;
	unpriced: string[];
}

/**
 * Old price table + normalized rows + the kit's model ids → { prices, report }.
 * Rules: entries with pin:true are never touched. Entries AWS lists become source:"aws" (the caller shows the diff
 * and writes only with --apply). Entries AWS doesn't list keep their hand values and get source:"manual". Kit models
 * with no entry yet get a new one (at the top, so it wins over broader patterns) when AWS lists them.
 */
export function buildPrices(
	oldPrices: PriceEntry[],
	rows: AwsPriceRow[],
	configModels: string[] = [],
	meta: PriceBuildMeta = {},
): { prices: PriceEntry[]; report: PriceBuildReport } {
	const ids = modelIds(rows);
	const out: PriceEntry[] = [];
	const report: PriceBuildReport = { mapped: [], manual: [], ambiguous: [], added: [], unpriced: [] };
	for (const entry of oldPrices) {
		if (isGlobalEntry(entry)) {
			continue; // regenerated next to its standard entry
		}
		if (entry.pin) {
			out.push(entry);
			report.manual.push({ pattern: entry.pattern, why: "pin" });
			continue;
		}
		let candidates =
			entry.awsModel && ids.includes(entry.awsModel) ? [entry.awsModel] : idsForPattern(entry.pattern, ids);
		const signatures = new Set(candidates.map((id) => JSON.stringify(entryPrices(rows, id, "standard"))));
		if (candidates.length > 1 && signatures.size > 1) {
			report.ambiguous.push({ pattern: entry.pattern, ids: candidates });
			candidates = [];
		}
		const id = candidates.find((candidate) => entryPrices(rows, candidate));
		const standard = id ? awsEntry(entry.pattern, rows, id, "standard", meta, entry) : null;
		if (!id || !standard) {
			out.push({ ...entry, source: "manual" });
			report.manual.push({
				pattern: entry.pattern,
				why: candidates.length ? "no standard input+output price" : "not in the AWS Price List",
			});
			continue;
		}
		const global = awsEntry(`^global\\..*(?:${entry.pattern})`, rows, id, "global", meta, entry);
		if (global) {
			out.push(global);
		}
		out.push(standard);
		report.mapped.push({ pattern: entry.pattern, awsModel: id, wasManual: entry.source !== "aws" });
	}
	const added: PriceEntry[] = [];
	for (const model of [...new Set(configModels)]) {
		if (out.some((entry) => tryRegExp(entry.pattern)?.test(model))) {
			continue;
		}
		const id = awsIdForModel(model, ids);
		const pattern = escapeRegExp(baseName(model));
		const standard = id ? awsEntry(pattern, rows, id, "standard", meta) : null;
		if (!id || !standard) {
			report.unpriced.push(model);
			continue;
		}
		const global = awsEntry(`^global\\..*(?:${pattern})`, rows, id, "global", meta);
		added.push(...(global ? [global, standard] : [standard]));
		report.added.push({ pattern, awsModel: id, model });
	}
	return { prices: [...added, ...out], report };
}

function formatEntry(entry: PriceEntry): string {
	const long = entry.long;
	return [
		...PRICE_KEYS.map((key) => `${key} ${entry[key]}`),
		long ? `long>${entry.longOver}: ${PRICE_KEYS.map((key) => long[key]).join("/")}` : null,
	]
		.filter(Boolean)
		.join(", ");
}

/** Human-readable differences between two price tables (keyed by pattern). [] = same prices and sources. */
export function diffPrices(oldPrices: PriceEntry[], newPrices: PriceEntry[]): string[] {
	const lines: string[] = [];
	const oldByPattern = new Map(oldPrices.map((entry) => [entry.pattern, entry]));
	const newByPattern = new Map(newPrices.map((entry) => [entry.pattern, entry]));
	for (const [pattern, next] of newByPattern) {
		const previous = oldByPattern.get(pattern);
		if (!previous) {
			lines.push(`+ ${pattern}: ${formatEntry(next)} [${next.source}${next.tier ? ` ${next.tier}` : ""}]`);
			continue;
		}
		const changes: string[] = [];
		for (const key of PRICE_KEYS) {
			if (previous[key] !== next[key]) {
				changes.push(`${key} ${previous[key]} → ${next[key]}`);
			}
		}
		if (previous.longOver !== next.longOver) {
			changes.push(`longOver ${previous.longOver} → ${next.longOver}`);
		}
		for (const key of PRICE_KEYS) {
			if (previous.long?.[key] !== next.long?.[key]) {
				changes.push(`long.${key} ${previous.long?.[key]} → ${next.long?.[key]}`);
			}
		}
		const oldSource = previous.source ?? "(none)";
		const newSource = next.source ?? "(none)";
		if (oldSource !== newSource) {
			changes.push(`source ${oldSource} → ${newSource}`);
		}
		if (changes.length) {
			const wasManual = previous.source !== "aws" && next.source === "aws" ? " (WAS MANUAL)" : "";
			lines.push(`~ ${pattern}${wasManual}: ${changes.join("; ")}`);
		}
	}
	for (const pattern of oldByPattern.keys()) {
		if (!newByPattern.has(pattern)) {
			lines.push(`- ${pattern}`);
		}
	}
	return lines;
}

export interface AwsRowDiff {
	changed: Array<AwsPriceRow & { from: number }>;
	added: AwsPriceRow[];
	removed: AwsPriceRow[];
}

/** Row-level change detection between two normalized snapshots. */
export function diffRows(previousRows: AwsPriceRow[], rows: AwsPriceRow[]): AwsRowDiff {
	const previousByKey = new Map(previousRows.map((row) => [rowKey(row), row]));
	const nextByKey = new Map(rows.map((row) => [rowKey(row), row]));
	const diff: AwsRowDiff = { changed: [], added: [], removed: [] };
	for (const [key, row] of nextByKey) {
		const previous = previousByKey.get(key);
		if (!previous) {
			diff.added.push(row);
		} else if (previous.usdPer1M !== row.usdPer1M) {
			diff.changed.push({ ...row, from: previous.usdPer1M });
		}
	}
	for (const [key, row] of previousByKey) {
		if (!nextByKey.has(key)) {
			diff.removed.push(row);
		}
	}
	return diff;
}
