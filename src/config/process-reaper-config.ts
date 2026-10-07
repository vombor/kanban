// Reads `processes.reaper` from the global config.json: the orphan sweeper's settings.
//
//   "processes": { "reaper": { "enabled": true, "intervalSec": 300, "mode": "terminate" } }
//
// `mode: "report"` finds and logs orphans without signalling them. The file is read on every sweep, so edits
// apply from the next sweep without a restart. A missing file or key means the defaults. When in doubt the
// reaper only reports: a config.json that can't be read or parsed, or a `mode` that isn't one of the two
// values, gives `mode: "report"` and a warning (logged once per distinct problem).
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { type RuntimeProcessReaperSettings, runtimeProcessReaperModeSchema } from "../core/api-contract";
import { getKanbanGlobalConfigPath } from "../state/kanban-home";

/** Sweeps closer together than this would mostly measure themselves. */
const MIN_INTERVAL_SEC = 30;

export const DEFAULT_PROCESS_REAPER_SETTINGS: RuntimeProcessReaperSettings = {
	enabled: true,
	intervalSec: 300,
	mode: "terminate",
};

export interface ParsedProcessReaperSettings {
	settings: RuntimeProcessReaperSettings;
	/** Why the settings fell back to report mode, if they did. */
	warning: string | null;
}

function readObjectKey(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export function parseProcessReaperSettings(config: unknown): ParsedProcessReaperSettings {
	const reaper = readObjectKey(readObjectKey(config, "processes"), "reaper");
	const enabled = z.boolean().safeParse(readObjectKey(reaper, "enabled"));
	const intervalSec = z.number().int().safeParse(readObjectKey(reaper, "intervalSec"));
	const rawMode = readObjectKey(reaper, "mode");
	const mode = runtimeProcessReaperModeSchema.safeParse(rawMode);
	const invalidMode = rawMode !== undefined && !mode.success;
	return {
		settings: {
			enabled: enabled.success ? enabled.data : DEFAULT_PROCESS_REAPER_SETTINGS.enabled,
			intervalSec: intervalSec.success
				? Math.max(MIN_INTERVAL_SEC, intervalSec.data)
				: DEFAULT_PROCESS_REAPER_SETTINGS.intervalSec,
			mode: mode.success ? mode.data : invalidMode ? "report" : DEFAULT_PROCESS_REAPER_SETTINGS.mode,
		},
		warning: invalidMode
			? `processes.reaper.mode ${JSON.stringify(rawMode)} is not "terminate" or "report"; only reporting.`
			: null,
	};
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function readProcessReaperSettings(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ParsedProcessReaperSettings> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return { settings: DEFAULT_PROCESS_REAPER_SETTINGS, warning: null };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...DEFAULT_PROCESS_REAPER_SETTINGS, mode: "report" },
			warning: `Could not read ${configPath} (${message}); only reporting orphan processes.`,
		};
	}
	try {
		return parseProcessReaperSettings(JSON.parse(raw));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...DEFAULT_PROCESS_REAPER_SETTINGS, mode: "report" },
			warning: `Could not parse ${configPath} (${message}); only reporting orphan processes.`,
		};
	}
}

/** A settings loader for the sweeper that logs each distinct fallback warning once. */
export function createProcessReaperSettingsLoader(
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<RuntimeProcessReaperSettings> {
	let lastWarning: string | null = null;
	return async () => {
		const { settings, warning } = await readProcessReaperSettings(configPath);
		if (warning && warning !== lastWarning) {
			warn(`[process-reaper] ${warning}`);
		}
		lastWarning = warning;
		return settings;
	};
}
