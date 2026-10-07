// `kanban models prices sync [--apply|--check]`: Bedrock list prices from the public AWS Price List bulk API (no
// credentials) → `data/prices/prices-aws.json` (machine-generated, normalized rows) → proposed `prices.json` entries.
//
//   (default)  fetch (only offers with a new version), write prices-aws.json, print the prices.json diff (dry run)
//   --apply    … and write prices.json
//   --check    the daily job (team kit `prices.autoSync`): fetch + change detection only; writes only the cache
//   --offline  use the cached files only     --force  re-download even if the version is unchanged
//
// Change detection (every run): normalized rows are compared with the previous run's (`rows-last.json`). A price
// change of a model in our table → one line in each watched workspace's ATTENTION.md "## Prices (info)" section and
// the price-sync log. Historical costs are not recomputed. prices.json is never written without --apply; entries AWS
// doesn't list stay as hand values (source "manual"); entries with "pin": true are never touched.
//
// Tier: our cards call us.* (US geographic cross-region) inference profiles. AWS bills geo cross-region at the source
// region's in-region rate, which is the Price List's "standard" ("Regional") row; "global" rows (about 10% cheaper)
// apply to global.* profiles and get their own "^global\." entries.
//
// Ported from archive/devteam-kit:bench/sync-prices.mjs@a3a92b0e.
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PricesDataPaths } from "../../../state/kanban-home";
import {
	type AwsOfferFile,
	type AwsPriceRow,
	buildPrices,
	diffPrices,
	diffRows,
	type LoadedAwsOffer,
	normalize,
} from "./aws-prices";
import { type PriceTableFile, priceTableFileSchema } from "./prices";

export const AWS_PRICE_LIST_HOST = "https://pricing.us-east-1.amazonaws.com";
export const BEDROCK_PRICE_OFFERS = ["AmazonBedrock", "AmazonBedrockFoundationModels", "AmazonBedrockService"] as const;
const FETCH_TIMEOUT_MS = 120_000;
const ATTENTION_INFO_HEADER = "## Prices (info)";
// The watchdog keeps this section verbatim from its header to the end of the file; the info section goes after it.
const ATTENTION_ORCHESTRATOR_HEADER = "## Orchestrator: needs the user";
const ATTENTION_INFO_KEEP = 5;
const CHANGE_DETAIL_MAX = 6;

export type PriceSyncMode = "dry-run" | "apply" | "check";

export interface PriceSyncOptions {
	mode: PriceSyncMode;
	region: string;
	paths: PricesDataPaths;
	/** The price table to compare against when `paths.pricesJson` doesn't exist yet (the legacy kit's or the seed). */
	baseTable: PriceTableFile;
	/** Where `baseTable` came from, for the output. */
	baseTableSource: string;
	/** Model ids the kits use (tiers + dropped): new table entries are proposed for them. */
	kitModels: string[];
	/** ATTENTION.md files that get the "## Prices (info)" line on a change of one of our models. */
	attentionFiles: string[];
	offline?: boolean;
	force?: boolean;
	fetchText?: (url: string) => Promise<string>;
	now?: () => Date;
}

interface OfferState {
	versionUrl: string;
	version: string;
	publicationDate?: string;
	fetchedAt?: string;
}

interface PriceSyncState {
	offers: Record<string, OfferState>;
	lastCheckAt?: string;
	pendingPricesJson?: number;
}

interface RowsSnapshot {
	versions: Record<string, string>;
	rows: AwsPriceRow[];
}

export interface PriceSyncResult {
	/** What the command prints. */
	lines: string[];
	/** The ATTENTION/log line for a price change, or null when nothing changed (or this is the baseline). */
	changeLine: string | null;
	/** prices.json entries that differ from AWS. */
	pending: string[];
	rows: number;
	versions: Record<string, string>;
	applied: boolean;
}

async function defaultFetchText(url: string): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`${url}: HTTP ${response.status}`);
	}
	return await response.text();
}

async function readJsonFile<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(`${path}.tmp`, text);
	await rename(`${path}.tmp`, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

const formatUsd = (value: number): string => String(Number(value.toFixed(6)));
const shortModelId = (id: string): string => id.replace(/^[a-z0-9]+\./u, "");
const describeVersions = (versions: Record<string, string>): string =>
	Object.entries(versions)
		.map(([code, version]) => `${code} ${version}`)
		.join(", ");

/** Puts `line` first in the file's "## Prices (info)" section (last 5 kept), after the orchestrator's section. */
export function insertPriceAttentionLine(previous: string, line: string): string {
	let head = previous;
	let info = "";
	let tail = "";
	const start = previous.indexOf(ATTENTION_INFO_HEADER);
	if (start >= 0) {
		head = previous.slice(0, start);
		const rest = previous.slice(start + ATTENTION_INFO_HEADER.length);
		const next = rest.search(/^## /mu);
		info = next < 0 ? rest : rest.slice(0, next);
		tail = next < 0 ? "" : rest.slice(next);
	}
	if (!head.includes(ATTENTION_ORCHESTRATOR_HEADER)) {
		head = `${head.trimEnd()}${head.trim() ? "\n\n" : ""}${ATTENTION_ORCHESTRATOR_HEADER}\n`;
	}
	const lines = [line, ...info.split("\n").filter((entry) => entry.startsWith("- "))].slice(0, ATTENTION_INFO_KEEP);
	return `${head.trimEnd()}\n\n${ATTENTION_INFO_HEADER}\n${lines.join("\n")}\n${tail ? `\n${tail.trimEnd()}\n` : ""}`;
}

export async function runPriceSync(options: PriceSyncOptions): Promise<PriceSyncResult> {
	const { paths, region } = options;
	const fetchText = options.fetchText ?? defaultFetchText;
	const now = (options.now ?? (() => new Date()))();
	const nowIso = now.toISOString();
	const lines: string[] = [];
	await mkdir(paths.rawDir, { recursive: true });
	await mkdir(dirname(paths.log), { recursive: true });
	const log = async (message: string): Promise<void> => {
		await appendFile(paths.log, `${nowIso} ${message}\n`);
	};

	try {
		const state = (await readJsonFile<PriceSyncState>(paths.state)) ?? { offers: {} };
		state.offers ??= {};

		// One offer: the current version URL for the region, the cached raw file (downloaded only on a new version).
		const loadOffer = async (code: string): Promise<LoadedAwsOffer & { meta: OfferState & { file: string } }> => {
			const previous = state.offers[code];
			let versionUrl = previous?.versionUrl;
			if (!options.offline) {
				const index = JSON.parse(
					await fetchText(`${AWS_PRICE_LIST_HOST}/offers/v1.0/aws/${code}/current/region_index.json`),
				) as { regions?: Record<string, { currentVersionUrl?: string }> };
				const current = index.regions?.[region]?.currentVersionUrl;
				if (!current) {
					throw new Error(`${code}: no ${region} in region_index.json`);
				}
				versionUrl = current;
			}
			if (!versionUrl) {
				throw new Error(`${code}: nothing cached (run without --offline)`);
			}
			const version = versionUrl.split("/").at(-3) ?? "unknown";
			const prefix = `${code}-${region}-`;
			const file = join(paths.rawDir, `${prefix}${version}.json`);
			let fetchedAt = previous?.fetchedAt;
			const cached = await readFile(file, "utf8").catch(() => null);
			let text = cached;
			if (text === null || options.force) {
				if (options.offline) {
					throw new Error(`${code}: ${file} not cached`);
				}
				text = await fetchText(AWS_PRICE_LIST_HOST + versionUrl);
				await writeFileAtomic(file, text);
				fetchedAt = nowIso;
				// Keep the previous version's file for comparison, drop older ones.
				const older = (await readdir(paths.rawDir))
					.filter((name) => name.startsWith(prefix) && name.endsWith(".json") && !name.includes(version))
					.sort();
				for (const name of older.slice(0, -1)) {
					await unlink(join(paths.rawDir, name)).catch(() => {});
				}
			}
			const offer = JSON.parse(text) as AwsOfferFile;
			return {
				offerCode: code,
				offer,
				meta: { versionUrl, version, publicationDate: offer.publicationDate, fetchedAt, file },
			};
		};

		const loaded = [];
		for (const code of BEDROCK_PRICE_OFFERS) {
			loaded.push(await loadOffer(code));
		}
		const { rows, conflicts } = normalize(loaded);
		const versions = Object.fromEntries(loaded.map((offer) => [offer.offerCode, offer.meta.version]));

		// ---- change detection against the previous run ----------------------------------------------------------
		const last =
			(await readJsonFile<RowsSnapshot>(paths.rowsLast)) ?? (await readJsonFile<RowsSnapshot>(paths.pricesAwsJson));
		const previousVersions = last?.versions ?? {};
		const versionChanges = BEDROCK_PRICE_OFFERS.filter(
			(code) => previousVersions[code] && previousVersions[code] !== versions[code],
		).map((code) => `${code} ${previousVersions[code]} → ${versions[code]}`);
		const ownTable = await readJsonFile<unknown>(paths.pricesJson);
		const ownParsed = ownTable === null ? null : priceTableFileSchema.safeParse(ownTable);
		if (ownParsed && !ownParsed.success) {
			throw new Error(`${paths.pricesJson} is not a valid price table; fix or remove it`);
		}
		const oldTable = ownParsed?.data ?? options.baseTable;
		const { prices: newList, report } = buildPrices(oldTable.prices, rows, options.kitModels, { versions, region });
		const pending = diffPrices(oldTable.prices, newList);
		let changeLine: string | null = null;
		if (last?.rows) {
			const diff = diffRows(last.rows, rows);
			if (diff.changed.length || diff.added.length || diff.removed.length) {
				const ours = new Set(newList.map((entry) => entry.awsModel).filter(Boolean));
				const mine = diff.changed.filter((row) => ours.has(row.modelId));
				const detail = mine
					.slice(0, CHANGE_DETAIL_MAX)
					.map(
						(row) =>
							`${shortModelId(row.modelId)} ${row.tier} ${row.kind} ${formatUsd(row.from)} → ${formatUsd(row.usdPer1M)}`,
					);
				const gone = diff.removed.filter((row) => ours.has(row.modelId)).map((row) => shortModelId(row.modelId));
				const previousIds = new Set(last.rows.map((row) => row.modelId));
				const newModels = [...new Set(diff.added.map((row) => row.modelId))].filter((id) => !previousIds.has(id));
				const otherChanged = diff.changed.length - mine.length;
				const parts = [
					detail.length
						? detail.join("; ") +
							(mine.length > CHANGE_DETAIL_MAX ? `; +${mine.length - CHANGE_DETAIL_MAX} more` : "")
						: "none of our models changed",
					otherChanged ? `${otherChanged} other price(s) changed` : null,
					gone.length ? `REMOVED for our models: ${[...new Set(gone)].join(", ")}` : null,
					newModels.length
						? `new models: ${newModels.slice(0, 5).map(shortModelId).join(", ")}${newModels.length > 5 ? ` +${newModels.length - 5}` : ""}`
						: null,
					pending.length
						? `prices.json: ${pending.length} entr${pending.length === 1 ? "y differs" : "ies differ"} from AWS, review with kanban models prices sync, then --apply`
						: "prices.json already matches",
				].filter(Boolean);
				const line = `- ${nowIso.slice(0, 16).replace("T", " ")}Z: AWS Bedrock prices changed (${versionChanges.join(", ") || "same version"}): ${parts.join(". ")}.`;
				await log(
					`changes: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed rows; ${line.slice(2)}`,
				);
				if (mine.length || gone.length) {
					changeLine = line;
					for (const file of options.attentionFiles) {
						const previous = await readFile(file, "utf8").catch(() => "");
						await writeFileAtomic(file, insertPriceAttentionLine(previous, line));
					}
				}
				lines.push(line);
			} else {
				await log(
					`no price changes (${describeVersions(versions)})${versionChanges.length ? `; new version(s): ${versionChanges.join(", ")}` : ""}`,
				);
			}
		} else {
			await log(`baseline: ${rows.length} rows (${describeVersions(versions)})`);
		}

		state.offers = Object.fromEntries(
			loaded.map((offer) => [
				offer.offerCode,
				{
					versionUrl: offer.meta.versionUrl,
					version: offer.meta.version,
					publicationDate: offer.meta.publicationDate,
					fetchedAt: offer.meta.fetchedAt,
				},
			]),
		);
		state.lastCheckAt = nowIso;
		state.pendingPricesJson = pending.length;
		await writeJsonAtomic(paths.state, state);
		await writeJsonAtomic(paths.rowsLast, { versions, rows } satisfies RowsSnapshot);
		const result: PriceSyncResult = { lines, changeLine, pending, rows: rows.length, versions, applied: false };
		if (options.mode === "check") {
			await log(
				`check done: ${rows.length} rows; prices.json ${pending.length ? `${pending.length} pending` : "in sync"}${conflicts.length ? `; ${conflicts.length} conflicts` : ""}`,
			);
			return result;
		}

		// ---- prices-aws.json (machine-generated) -------------------------------------------------------------------
		const sources = Object.fromEntries(
			loaded.map((offer) => [
				offer.offerCode,
				{
					version: offer.meta.version,
					versionUrl: AWS_PRICE_LIST_HOST + offer.meta.versionUrl,
					publicationDate: offer.meta.publicationDate,
					fetchedAt: offer.meta.fetchedAt,
				},
			]),
		);
		const body = [
			"{",
			`  "//": ${JSON.stringify("MACHINE-GENERATED by kanban models prices sync from the AWS Price List bulk API; do not edit. usdPer1M = $ per 1M tokens. tier: standard (in-region = us.* geo cross-region), global (global.* profiles), long_ctx, flex, priority, batch, latency and combinations. kind: input, output, cacheRead, cacheWrite5m, cacheWrite30m, cacheWrite1h.")},`,
			`  "region": ${JSON.stringify(region)},`,
			`  "generatedAt": ${JSON.stringify(nowIso)},`,
			`  "versions": ${JSON.stringify(versions)},`,
			`  "sources": ${JSON.stringify(sources, null, 2).replace(/\n/gu, "\n  ")},`,
			`  "conflicts": ${JSON.stringify(conflicts)},`,
			`  "rows": [`,
			rows
				.map(
					(row) =>
						`    ${JSON.stringify({ modelId: row.modelId, tier: row.tier, kind: row.kind, usdPer1M: row.usdPer1M, offer: row.offer, usagetype: row.usagetype })}`,
				)
				.join(",\n"),
			"  ]",
			"}",
		].join("\n");
		await writeFileAtomic(paths.pricesAwsJson, `${body}\n`);
		lines.push(
			`${paths.pricesAwsJson}: ${rows.length} rows from ${describeVersions(versions)}${conflicts.length ? ` (${conflicts.length} conflicting duplicates, kept the higher price)` : ""}`,
		);

		// ---- prices.json -------------------------------------------------------------------------------------------
		for (const entry of report.mapped) {
			lines.push(`  aws     ${entry.pattern} ← ${entry.awsModel}${entry.wasManual ? " (was hand-entered)" : ""}`);
		}
		for (const entry of report.added) {
			lines.push(`  new     ${entry.pattern} ← ${entry.awsModel} (kit model ${entry.model})`);
		}
		for (const entry of report.manual) {
			lines.push(`  manual  ${entry.pattern}: ${entry.why}`);
		}
		for (const entry of report.ambiguous) {
			lines.push(
				`  AMBIGUOUS ${entry.pattern}: ${entry.ids.join(", ")} (kept as manual; set "awsModel" on the entry)`,
			);
		}
		for (const model of report.unpriced) {
			lines.push(`  unpriced kit model ${model}: no prices.json entry and not in the AWS Price List`);
		}
		if (!pending.length) {
			lines.push(
				`prices.json: in sync with AWS${ownParsed ? "" : ` (no ${paths.pricesJson} yet: compared with ${options.baseTableSource})`}`,
			);
			return result;
		}
		lines.push(
			`prices.json: ${pending.length} change(s)${options.mode === "apply" ? "" : " (dry run; --apply writes them)"}:`,
		);
		lines.push(...pending.map((line) => `  ${line}`));
		if (options.mode !== "apply") {
			return result;
		}
		await writeJsonAtomic(paths.pricesJson, { ...oldTable, prices: newList });
		await log(
			`applied ${pending.length} prices.json change(s): ${pending.map((line) => line.split(":")[0]).join(", ")}`,
		);
		lines.push(`wrote ${paths.pricesJson}`);
		return { ...result, applied: true };
	} catch (error) {
		await log(`FAILED: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
		throw error;
	}
}
