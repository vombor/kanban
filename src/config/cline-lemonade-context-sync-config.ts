// Reads `agents.cline.lemonadeContextSync` from the global config.json: the server's sync of Cline's Lemonade
// context windows (src/setup/cline-lemonade-context-sync.ts, issue #31). Machine-wide, since Cline's models.json is.
//
//   "agents": { "cline": { "lemonadeContextSync": { "mode": "on", "intervalSec": 30 } } }
//
// `mode`: "on" (the default: write contextWindow/maxTokens when Lemonade's ctx_size changed), "report" (log what it
// would write, write nothing), "off" (no sync; doctor still warns about the difference). The file is read on every
// tick, so edits apply without a restart. A missing file or key means the defaults; a config.json that can't be read
// or parsed, or a `mode` that isn't one of the three, gives "report" and a warning (logged once per distinct problem).
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getClineDataDirPath, getKanbanGlobalConfigPath } from "../state/kanban-home";

export const clineLemonadeContextSyncModeSchema = z.enum(["off", "report", "on"]);
export type ClineLemonadeContextSyncMode = z.infer<typeof clineLemonadeContextSyncModeSchema>;

export const CLINE_LEMONADE_CONTEXT_SYNC_KEY = "agents.cline.lemonadeContextSync";

export interface ClineLemonadeContextSyncSettings {
	mode: ClineLemonadeContextSyncMode;
	intervalSec: number;
	/** Cline's data dir (models.json is `<dataDir>/settings/models.json`). */
	dataDir: string;
}

export const DEFAULT_CLINE_LEMONADE_CONTEXT_SYNC = { mode: "on", intervalSec: 30 } as const;

const MIN_INTERVAL_SEC = 5;

export function getDefaultClineLemonadeContextSyncSettings(): ClineLemonadeContextSyncSettings {
	return { ...DEFAULT_CLINE_LEMONADE_CONTEXT_SYNC, dataDir: getClineDataDirPath() };
}

export interface ParsedClineLemonadeContextSyncSettings {
	settings: ClineLemonadeContextSyncSettings;
	warning: string | null;
}

function readObjectKey(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export function parseClineLemonadeContextSyncSettings(config: unknown): ParsedClineLemonadeContextSyncSettings {
	const defaults = getDefaultClineLemonadeContextSyncSettings();
	const cline = readObjectKey(readObjectKey(config, "agents"), "cline");
	const sync = readObjectKey(cline, "lemonadeContextSync");
	const rawMode = readObjectKey(sync, "mode");
	const mode = clineLemonadeContextSyncModeSchema.safeParse(rawMode);
	const invalidMode = rawMode !== undefined && !mode.success;
	const intervalSec = z.number().int().safeParse(readObjectKey(sync, "intervalSec"));
	const dataDir = z.string().trim().min(1).safeParse(readObjectKey(cline, "dataDir"));
	return {
		settings: {
			mode: mode.success ? mode.data : invalidMode ? "report" : defaults.mode,
			intervalSec: intervalSec.success ? Math.max(MIN_INTERVAL_SEC, intervalSec.data) : defaults.intervalSec,
			dataDir: getClineDataDirPath(dataDir.success ? dataDir.data : null),
		},
		warning: invalidMode
			? `${CLINE_LEMONADE_CONTEXT_SYNC_KEY}.mode ${JSON.stringify(rawMode)} is not "off", "report" or "on"; only reporting.`
			: null,
	};
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function readClineLemonadeContextSyncSettings(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ParsedClineLemonadeContextSyncSettings> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return { settings: getDefaultClineLemonadeContextSyncSettings(), warning: null };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...getDefaultClineLemonadeContextSyncSettings(), mode: "report" },
			warning: `Could not read ${configPath} (${message}); the Lemonade context sync only reports.`,
		};
	}
	try {
		return parseClineLemonadeContextSyncSettings(JSON.parse(raw));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...getDefaultClineLemonadeContextSyncSettings(), mode: "report" },
			warning: `Could not parse ${configPath} (${message}); the Lemonade context sync only reports.`,
		};
	}
}

/** A settings loader that logs each distinct fallback warning once. */
export function createClineLemonadeContextSyncSettingsLoader(
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<ClineLemonadeContextSyncSettings> {
	let lastWarning: string | null = null;
	return async () => {
		const { settings, warning } = await readClineLemonadeContextSyncSettings(configPath);
		if (warning && warning !== lastWarning) {
			warn(`[cline-lemonade-sync] ${warning}`);
		}
		lastWarning = warning;
		return settings;
	};
}
