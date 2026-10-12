// Keeps Cline's Lemonade context windows equal to Lemonade's ctx_size (`agents.cline.lemonadeContextSync`, issue
// #31; what is written and what is left to the user is src/setup/cline-lemonade-context-sync.ts). The server runs it
// every `intervalSec` (default 30 s) without a browser, and once more right before every Cline card launch
// (`sync("launch")`, runtime-api.ts), so a card started right after a model reload already gets the new window; a
// running Cline session keeps the window it started with. Machine-wide, as Cline's models.json is.
//
// Every write, report-mode "would write", skipped change and failed write goes to the server log and to
// `<home>/data/models/cline-lemonade-sync.jsonl` (old -> new per model, with the Lemonade value it came from). An
// unchanged outcome is logged once, not every sweep; Lemonade being down or an unreadable models.json only goes to
// the server log (nothing was compared, so nothing was written or skipped).
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
	CLINE_LEMONADE_CONTEXT_SYNC_KEY,
	type ClineLemonadeContextSyncSettings,
	getDefaultClineLemonadeContextSyncSettings,
} from "../config/cline-lemonade-context-sync-config";
import type { LemonadeModelListSettings } from "../config/model-lists-config";
import { getClineBackupDir } from "../setup/cline-file-write";
import {
	type LemonadeContextChange,
	type LemonadeContextSyncResult,
	syncClineLemonadeContextWindows,
} from "../setup/cline-lemonade-context-sync";
import { getClineLemonadeSyncHistoryPath, getClineModelsSettingsPath } from "../state/kanban-home";

/** Per Lemonade request: it is local, and a card launch waits for the sync. */
const LEMONADE_TIMEOUT_MS = 1_500;

const LOG_PREFIX = "[cline-lemonade-sync]";

export type ClineLemonadeContextSyncTrigger = "sweep" | "launch";

export interface ClineLemonadeContextSyncRecord {
	at: string;
	trigger: ClineLemonadeContextSyncTrigger;
	status: "written" | "would-write" | "skipped" | "failed";
	modelsPath: string;
	lemonadeApiBaseUrl: string | null;
	changes: LemonadeContextChange[];
	skipped: LemonadeContextSyncResult["skipped"];
	backupPath: string | null;
	detail: string | null;
}

export interface ClineLemonadeContextSyncMonitorDependencies {
	loadSettings: () => Promise<ClineLemonadeContextSyncSettings>;
	loadLemonadeModelList: () => Promise<LemonadeModelListSettings>;
	log: (message: string) => void;
	/** Default: `<home>/data/models/cline-lemonade-sync.jsonl`. */
	historyPath?: string;
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	fetch?: typeof fetch;
	now?: () => Date;
}

export interface ClineLemonadeContextSyncMonitor {
	/** One sync now (joins one already running); null with the sync off. Never throws. */
	sync: (trigger: ClineLemonadeContextSyncTrigger) => Promise<LemonadeContextSyncResult | null>;
	start: () => void;
	close: () => void;
}

function formatValue(value: unknown): string {
	return value === undefined ? "(unset)" : JSON.stringify(value);
}

export function describeLemonadeContextChange(change: LemonadeContextChange): string {
	return `${change.id}: contextWindow ${formatValue(change.contextWindow.from)} -> ${change.contextWindow.to}, maxTokens ${formatValue(change.maxTokens.from)} -> ${change.maxTokens.to} (Lemonade ${change.lemonade.source === "loaded" ? "loaded model's" : "recipe's"} recipe_options.ctx_size ${change.lemonade.ctxSize})`;
}

function describeResult(result: LemonadeContextSyncResult, mode: ClineLemonadeContextSyncSettings["mode"]): string[] {
	const head: Record<ClineLemonadeContextSyncRecord["status"], string> = {
		written: `wrote ${result.modelsPath} (backup ${result.backupPath})`,
		"would-write": `would write ${result.modelsPath} (${CLINE_LEMONADE_CONTEXT_SYNC_KEY}.mode is ${mode})`,
		skipped: `left ${result.modelsPath} alone`,
		failed: `could not write ${result.modelsPath}: ${result.detail}`,
	};
	const status = result.status as ClineLemonadeContextSyncRecord["status"];
	return [
		head[status],
		...result.changes.map((change) => `  ${describeLemonadeContextChange(change)}`),
		...result.skipped.map((skip) => `  ${skip.id ?? "all models"}: skipped, ${skip.reason}`),
		...(result.userDifferences > 0
			? [`  ${result.userDifferences} other difference(s) are left to \`kanban setup-provider lemonade\``]
			: []),
	];
}

export function createClineLemonadeContextSyncMonitor(
	deps: ClineLemonadeContextSyncMonitorDependencies,
): ClineLemonadeContextSyncMonitor {
	const now = (): Date => deps.now?.() ?? new Date();
	let running: Promise<LemonadeContextSyncResult | null> | null = null;
	let timer: NodeJS.Timeout | null = null;
	let closed = false;
	// The last outcome logged, so an unchanged one isn't logged every sweep.
	let lastLoggedKey: string | null = null;

	const appendHistory = async (record: ClineLemonadeContextSyncRecord): Promise<void> => {
		const path = deps.historyPath ?? getClineLemonadeSyncHistoryPath();
		try {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			deps.log(
				`${LOG_PREFIX} could not append to ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const report = async (
		result: LemonadeContextSyncResult,
		trigger: ClineLemonadeContextSyncTrigger,
		mode: ClineLemonadeContextSyncSettings["mode"],
	): Promise<void> => {
		if (result.status === "absent" || result.status === "in-sync") {
			lastLoggedKey = null;
			return;
		}
		if (result.status === "unreachable" || result.status === "unreadable") {
			const key = `${result.status}:${result.detail}`;
			if (key !== lastLoggedKey) {
				deps.log(`${LOG_PREFIX} ${result.modelsPath}: ${result.detail}`);
			}
			lastLoggedKey = key;
			return;
		}
		// A write changes the file, so it is never a repeat; the others are logged once per distinct outcome.
		const key = JSON.stringify([result.status, result.changes, result.skipped, result.detail]);
		if (result.status !== "written" && key === lastLoggedKey) {
			return;
		}
		lastLoggedKey = result.status === "written" ? null : key;
		for (const line of describeResult(result, mode)) {
			deps.log(`${LOG_PREFIX} ${line}`);
		}
		await appendHistory({
			at: now().toISOString(),
			trigger,
			status: result.status,
			modelsPath: result.modelsPath,
			lemonadeApiBaseUrl: result.lemonadeApiBaseUrl,
			changes: result.changes,
			skipped: result.skipped,
			backupPath: result.backupPath,
			detail: result.detail,
		});
	};

	const runSync = async (
		trigger: ClineLemonadeContextSyncTrigger,
		settings: ClineLemonadeContextSyncSettings,
	): Promise<LemonadeContextSyncResult | null> => {
		if (settings.mode === "off") {
			lastLoggedKey = null;
			return null;
		}
		const lemonade = await deps.loadLemonadeModelList();
		const result = await syncClineLemonadeContextWindows({
			modelsPath: getClineModelsSettingsPath(settings.dataDir),
			mode: settings.mode,
			requireLabels: lemonade.requireLabels,
			include: lemonade.include,
			lemonadeUrl: lemonade.url,
			fetch: deps.fetch,
			timeoutMs: LEMONADE_TIMEOUT_MS,
			backupDir: deps.backupDir ?? getClineBackupDir(),
			now: now(),
		});
		await report(result, trigger, settings.mode);
		return result;
	};

	const syncWith = async (
		trigger: ClineLemonadeContextSyncTrigger,
		settings: ClineLemonadeContextSyncSettings,
	): Promise<LemonadeContextSyncResult | null> => {
		running ??= runSync(trigger, settings)
			.catch((error: unknown) => {
				deps.log(`${LOG_PREFIX} sync failed: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			})
			.finally(() => {
				running = null;
			});
		return await running;
	};

	const loadSettings = async (): Promise<ClineLemonadeContextSyncSettings> =>
		await deps.loadSettings().catch((error: unknown) => {
			deps.log(
				`${LOG_PREFIX} could not load settings (${error instanceof Error ? error.message : String(error)}); only reporting`,
			);
			return { ...getDefaultClineLemonadeContextSyncSettings(), mode: "report" as const };
		});

	const schedule = (delayMs: number): void => {
		if (closed) {
			return;
		}
		timer = setTimeout(() => {
			void loop();
		}, delayMs);
		timer.unref();
	};

	const loop = async (): Promise<void> => {
		const settings = await loadSettings();
		await syncWith("sweep", settings);
		schedule(settings.intervalSec * 1000);
	};

	return {
		sync: async (trigger) => await syncWith(trigger, await loadSettings()),
		start: () => {
			// The first sweep right away: a reload while the server was down is caught before the first launch.
			schedule(0);
		},
		close: () => {
			closed = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
