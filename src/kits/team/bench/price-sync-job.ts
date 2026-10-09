// The `bench` feature's inputs for the price sync, and its daily check as a feature job.
//
// Prices are machine-wide (one `data/prices/`), but which models matter and where a change is reported are per
// workspace: every workspace whose resolved kit lists `bench` contributes its kit's tier and dropped models and its
// ATTENTION.md. With no such workspace (the pod today: every project is on `default`), `kanban models prices sync`
// falls back to the built-in `team` kit's models and reports to no ATTENTION.md.
//
// The daily check (was review-watch's PRICE_SYNC toggle, archive/devteam-kit:services/review-watch.mjs@6da71597)
// is a job the `bench` feature registers for each of its workspaces (bench-feature.ts); the watchdog runs it only in
// `watchdog.mode: "on"`. Whichever workspace's job runs first does the machine-wide check, and the others see the
// fresh `lastCheckAt` and skip.
import { readFile } from "node:fs/promises";

import { type PipelineConfig, readPipelineConfig } from "../../../config/pipeline-config";
import type { PipelineFeatureJob } from "../../../pipeline/features";
import { getPricesDataPaths, getTeamBenchWorkspacePaths, type PricesDataPaths } from "../../../state/kanban-home";
import type { KitDocument } from "../../kit-schema";
import { type KitCatalog, loadKitCatalog, resolveKitByName, resolveWorkspaceKit } from "../../resolve-kit";
import { type PriceSyncResult, runPriceSync } from "./price-sync";
import { isLocalProvider, loadPriceTable } from "./prices";

const DEFAULT_PRICES_REGION = "us-west-2";
const TEAM_KIT_NAME = "team";
export const PRICE_CHECK_JOB_NAME = "prices-check";
export const PRICE_CHECK_EVERY_MIN = 24 * 60;
// A job that comes due a little early (worker restarts, clock drift) doesn't fetch twice in one day.
const PRICE_CHECK_MIN_GAP_MS = 23 * 60 * 60 * 1000;

export interface BenchPriceContext {
	/** Workspaces whose kit lists `bench`. */
	workspaceIds: string[];
	region: string;
	/** The kits' tier and dropped models (new price entries are proposed for them). */
	kitModels: string[];
	attentionFiles: string[];
	/** False when every bench workspace's kit says `prices.autoSync: false`. */
	autoSync: boolean;
}

/** The kit models the AWS price check proposes entries for: local-provider models (Lemonade) cost nothing, skipped. */
export function listKitModels(kit: KitDocument): string[] {
	const models = [...Object.values(kit.tiers ?? {}).flat(), ...(kit.dropped ?? [])]
		.filter((entry) => !isLocalProvider(entry.provider))
		.map((entry) => entry.model);
	return [...new Set(models)];
}

export function collectBenchPriceContext(config: PipelineConfig, catalog: KitCatalog): BenchPriceContext {
	const kits: Array<{ workspaceId: string; kit: KitDocument }> = [];
	for (const workspaceId of Object.keys(config.workspaces)) {
		const { kit } = resolveWorkspaceKit(config, workspaceId, catalog);
		if (kit.features?.includes("bench")) {
			kits.push({ workspaceId, kit });
		}
	}
	if (!kits.length) {
		const team = resolveKitByName(catalog, TEAM_KIT_NAME);
		const kit = team.ok ? team.kit : null;
		return {
			workspaceIds: [],
			region: kit?.prices?.region ?? DEFAULT_PRICES_REGION,
			kitModels: kit ? listKitModels(kit) : [],
			attentionFiles: [],
			autoSync: false,
		};
	}
	return {
		workspaceIds: kits.map((entry) => entry.workspaceId),
		region: kits.find((entry) => entry.kit.prices?.region)?.kit.prices?.region ?? DEFAULT_PRICES_REGION,
		kitModels: [...new Set(kits.flatMap((entry) => listKitModels(entry.kit)))],
		attentionFiles: kits.map((entry) => getTeamBenchWorkspacePaths(entry.workspaceId).attention),
		autoSync: kits.some((entry) => entry.kit.prices?.autoSync !== false),
	};
}

export interface PriceCheckJobDependencies {
	/** Default: the bench workspaces of the current config.json and kits. */
	readContext?: () => Promise<BenchPriceContext>;
	paths?: PricesDataPaths;
	sync?: typeof runPriceSync;
	now?: () => Date;
}

async function readLastCheckAt(statePath: string): Promise<number | null> {
	try {
		const state = JSON.parse(await readFile(statePath, "utf8")) as { lastCheckAt?: unknown };
		const at = typeof state.lastCheckAt === "string" ? Date.parse(state.lastCheckAt) : Number.NaN;
		return Number.isFinite(at) ? at : null;
	} catch {
		return null;
	}
}

/** The bench price context of the config.json and kits on disk now (a kit change needs no restart). */
export async function readBenchPriceContext(): Promise<BenchPriceContext> {
	const { config } = await readPipelineConfig();
	return collectBenchPriceContext(config, await loadKitCatalog());
}

function summarize(result: PriceSyncResult): string {
	const pending = result.pending.length
		? `${result.pending.length} prices.json entr${result.pending.length === 1 ? "y" : "ies"} pending`
		: "prices.json in sync";
	return `${result.rows} rows; ${pending}${result.changeLine ? `; ${result.changeLine.slice(2)}` : ""}`;
}

/** The daily `kanban models prices sync --check`, as a feature job. */
export function createPriceCheckJob(deps: PriceCheckJobDependencies = {}): PipelineFeatureJob {
	const readContext = deps.readContext ?? readBenchPriceContext;
	const paths = deps.paths ?? getPricesDataPaths();
	const sync = deps.sync ?? runPriceSync;
	const now = deps.now ?? (() => new Date());
	return {
		name: PRICE_CHECK_JOB_NAME,
		everyMin: PRICE_CHECK_EVERY_MIN,
		run: async () => {
			const context = await readContext();
			if (!context.autoSync) {
				return "skipped: prices.autoSync is off";
			}
			const last = await readLastCheckAt(paths.state);
			if (last !== null && now().getTime() - last < PRICE_CHECK_MIN_GAP_MS) {
				return `skipped: checked at ${new Date(last).toISOString()}`;
			}
			const base = await loadPriceTable();
			const result = await sync({
				mode: "check",
				region: context.region,
				paths,
				baseTable: base.file,
				baseTableSource: base.source,
				kitModels: context.kitModels,
				attentionFiles: context.attentionFiles,
				now,
			});
			return summarize(result);
		},
	};
}
