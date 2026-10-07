// `kanban models prices sync [--apply|--check]`: the team kit's price table from the AWS Price List (bench/price-sync.ts).
// Reads the public bulk API (no credentials). Writes only `<home>/data/prices/` (cache, prices-aws.json) and, with
// --apply, `data/prices/prices.json`; a price change of one of our models goes to each bench workspace's ATTENTION.md.
//
// Ported from archive/devteam-kit:bench/sync-prices.mjs@a3a92b0e.
import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { loadKitCatalog } from "../kits/resolve-kit";
import { type PriceSyncMode, runPriceSync } from "../kits/team/bench/price-sync";
import { collectBenchPriceContext } from "../kits/team/bench/price-sync-job";
import { loadPriceTable } from "../kits/team/bench/prices";
import { getPricesDataPaths } from "../state/kanban-home";

interface PricesSyncOptions {
	apply?: boolean;
	check?: boolean;
	offline?: boolean;
	force?: boolean;
	region?: string;
	json?: boolean;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

async function runPricesSync(options: PricesSyncOptions): Promise<number> {
	if (options.apply && options.check) {
		throw new Error("--apply and --check exclude each other");
	}
	const mode: PriceSyncMode = options.apply ? "apply" : options.check ? "check" : "dry-run";
	const { config } = await readPipelineConfig();
	const context = collectBenchPriceContext(config, await loadKitCatalog());
	const base = await loadPriceTable();
	const paths = getPricesDataPaths();
	const result = await runPriceSync({
		mode,
		region: options.region ?? context.region,
		paths,
		baseTable: base.file,
		baseTableSource: base.source,
		kitModels: context.kitModels,
		attentionFiles: context.attentionFiles,
		offline: options.offline,
		force: options.force,
	});
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ mode, ...result, pricesJson: paths.pricesJson }, null, 2)}\n`);
	} else if (result.lines.length) {
		process.stdout.write(`${result.lines.join("\n")}\n`);
	} else {
		process.stdout.write(
			`prices: ${result.rows} rows checked; ${result.pending.length} prices.json change(s) pending\n`,
		);
	}
	return 0;
}

export function registerModelPricesCommand(models: Command): void {
	const prices = models
		.command("prices")
		.description("The team kit's model price table (data/prices in the Kanban home).");
	prices
		.command("sync")
		.description(
			"Fetch Bedrock list prices from the public AWS Price List, write data/prices/prices-aws.json and show the prices.json diff (dry run unless --apply).",
		)
		.option("--apply", "Write the proposed data/prices/prices.json.")
		.option(
			"--check",
			"Change detection only (the daily job): updates the cache, reports price changes, writes no table.",
		)
		.option("--offline", "Use the cached offer files only.")
		.option("--force", "Re-download the offer files even if their version is unchanged.")
		.option(
			"--region <region>",
			"AWS region of the price list (default: the bench kits' prices.region, else us-west-2).",
		)
		.option("--json", "Print JSON.")
		.action(async (options: PricesSyncOptions) => {
			try {
				process.exitCode = await runPricesSync(options);
			} catch (error) {
				process.stderr.write(`Models prices sync failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
