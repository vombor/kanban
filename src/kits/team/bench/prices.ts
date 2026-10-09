// The team kit's model price table (`bench` feature): $ per 1M tokens by model-id pattern, first match wins. Card
// metrics price every assistant turn with it. The live table is `<home>/data/prices/prices.json`
// (`kanban models prices sync --apply` writes it); until cutover the legacy kit's `bench/prices.json` is read when
// the home has none, and the package's seed (`assets/prices.default.json`) when neither exists.
//
// Ported from archive/devteam-kit:bench/card-metrics.cjs@760fd36c (PRICES, turnCost, priceFor).
import { readFile } from "node:fs/promises";
import { z } from "zod";

import seedPricesJson from "../../../../assets/prices.default.json" with { type: "json" };
import { getPriceTableCandidatePaths } from "../../../state/kanban-home";

const priceRatesSchema = z.object({
	in: z.number().nonnegative(),
	cacheRead: z.number().nonnegative(),
	cacheWrite: z.number().nonnegative(),
	out: z.number().nonnegative(),
});

export const priceEntrySchema = z.looseObject({
	...priceRatesSchema.shape,
	/** Regex on the model id. */
	pattern: z.string().min(1),
	/** Input tokens per request above which `long` applies (per turn). */
	longOver: z.number().int().positive().optional(),
	long: priceRatesSchema.optional(),
	source: z.enum(["aws", "manual"]).optional(),
	awsModel: z.string().optional(),
	tier: z.string().optional(),
	pin: z.boolean().optional(),
	note: z.string().optional(),
});

export const priceTableFileSchema = z.looseObject({ prices: z.array(priceEntrySchema) });

export type PriceRates = z.infer<typeof priceRatesSchema>;
export type PriceEntry = z.infer<typeof priceEntrySchema>;
export type PriceTableFile = z.infer<typeof priceTableFileSchema>;

/** One assistant turn's tokens. Cline's and Codex's input counts INCLUDE cache reads and writes. */
export interface TurnTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface PriceTable {
	/** Where the table came from (a file path, or "seed"). */
	source: string;
	file: PriceTableFile;
	/** A turn on a local provider (`LOCAL_PROVIDER_IDS`) is free whatever its model id; else the first matching entry. */
	priceFor: (model: string | null | undefined, provider?: string | null) => PriceEntry | null;
}

/**
 * Providers that run on this machine and charge nothing per token: Lemonade (llama.cpp GGUF). Its model ids are
 * whatever the server lists ("GLM-4.7-Flash-GGUF", "LMX-Omni-52B-Halo", "DeepSeek-V4-Flash-0731-GGUF-BF16"), so no
 * id pattern in the table can tell them apart from a paid model; the provider can. A live prices.json written
 * before this rule needs no edit.
 */
export const LOCAL_PROVIDER_IDS: readonly string[] = ["lemonade"];

export function isLocalProvider(provider: string | null | undefined): boolean {
	return Boolean(provider && LOCAL_PROVIDER_IDS.includes(provider));
}

const LOCAL_PROVIDER_PRICE: PriceEntry = {
	pattern: ".*",
	in: 0,
	cacheRead: 0,
	cacheWrite: 0,
	out: 0,
	pin: true,
	source: "manual",
	note: "local provider: no per-token cost",
};

function compilePattern(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

export function createPriceTable(file: PriceTableFile, source: string): PriceTable {
	const compiled = file.prices
		.map((entry) => ({ entry, re: compilePattern(entry.pattern) }))
		.filter((item): item is { entry: PriceEntry; re: RegExp } => item.re !== null);
	return {
		source,
		file,
		priceFor: (model, provider) =>
			isLocalProvider(provider)
				? LOCAL_PROVIDER_PRICE
				: (compiled.find(({ re }) => re.test(model ?? ""))?.entry ?? null),
	};
}

export function getSeedPriceTableFile(): PriceTableFile {
	return priceTableFileSchema.parse(seedPricesJson);
}

/** The first readable, valid table of getPriceTableCandidatePaths(), else the seed. */
export async function loadPriceTable(candidates: string[] = getPriceTableCandidatePaths()): Promise<PriceTable> {
	for (const path of candidates) {
		const text = await readFile(path, "utf8").catch(() => null);
		if (text === null) {
			continue;
		}
		try {
			const parsed = priceTableFileSchema.safeParse(JSON.parse(text));
			if (parsed.success) {
				return createPriceTable(parsed.data, path);
			}
		} catch {
			// An unreadable table falls through to the next candidate.
		}
	}
	return createPriceTable(getSeedPriceTableFile(), "seed");
}

/**
 * $ for one turn. Cache reads and writes are priced separately from plain input; the long-context rate applies
 * per turn when that turn's input exceeds `longOver` (luna's 272K rule).
 */
export function turnCost(entry: PriceEntry, turn: TurnTokens): number {
	const rates = entry.longOver && entry.long && turn.input > entry.longOver ? entry.long : entry;
	const plain = Math.max(0, turn.input - turn.cacheRead - turn.cacheWrite);
	return (
		(plain * rates.in +
			turn.cacheRead * rates.cacheRead +
			turn.cacheWrite * rates.cacheWrite +
			turn.output * rates.out) /
		1e6
	);
}

/** The old all-input-at-full-price upper bound. */
export function turnCostNoCache(entry: PriceEntry, turn: TurnTokens): number {
	return (turn.input * entry.in + turn.output * entry.out) / 1e6;
}
