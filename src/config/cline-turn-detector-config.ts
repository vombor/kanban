// Reads `agents.cline` from the global config.json: the Cline CLI turn-end detector's settings.
//
//   "agents": { "cline": { "dataDir": "~/.cline/data", "turnDetector": { "mode": "report", "intervalSec": 15 } } }
//
// `mode`: "off" (no polling), "report" (log the turns it would end, change nothing; the default while the
// legacy kit's column-sync still ends them), "on" (end the turn in Kanban, as Cline's TaskComplete hook does).
// The file is read on every tick, so edits apply without a restart. A missing file or key means the defaults; a
// config.json that can't be read or parsed, or a `mode` that isn't one of the three, gives "report" and a
// warning (logged once per distinct problem).
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getClineDataDirPath, getKanbanGlobalConfigPath } from "../state/kanban-home";

export const clineTurnDetectorModeSchema = z.enum(["off", "report", "on"]);
export type ClineTurnDetectorMode = z.infer<typeof clineTurnDetectorModeSchema>;

export interface ClineTurnDetectorSettings {
	mode: ClineTurnDetectorMode;
	intervalSec: number;
	/** Cline's data dir (sessions live in `<dataDir>/sessions`). */
	dataDir: string;
}

const MIN_INTERVAL_SEC = 5;

export function getDefaultClineTurnDetectorSettings(): ClineTurnDetectorSettings {
	return { mode: "report", intervalSec: 15, dataDir: getClineDataDirPath() };
}

export interface ParsedClineTurnDetectorSettings {
	settings: ClineTurnDetectorSettings;
	warning: string | null;
}

function readObjectKey(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export function parseClineTurnDetectorSettings(config: unknown): ParsedClineTurnDetectorSettings {
	const defaults = getDefaultClineTurnDetectorSettings();
	const cline = readObjectKey(readObjectKey(config, "agents"), "cline");
	const detector = readObjectKey(cline, "turnDetector");
	const rawMode = readObjectKey(detector, "mode");
	const mode = clineTurnDetectorModeSchema.safeParse(rawMode);
	const invalidMode = rawMode !== undefined && !mode.success;
	const intervalSec = z.number().int().safeParse(readObjectKey(detector, "intervalSec"));
	const dataDir = z.string().trim().min(1).safeParse(readObjectKey(cline, "dataDir"));
	return {
		settings: {
			mode: mode.success ? mode.data : invalidMode ? "report" : defaults.mode,
			intervalSec: intervalSec.success ? Math.max(MIN_INTERVAL_SEC, intervalSec.data) : defaults.intervalSec,
			// The one lookup every Cline session-file reader uses (recovery, the watchdog, this detector).
			dataDir: getClineDataDirPath(dataDir.success ? dataDir.data : null),
		},
		warning: invalidMode
			? `agents.cline.turnDetector.mode ${JSON.stringify(rawMode)} is not "off", "report" or "on"; only reporting.`
			: null,
	};
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function readClineTurnDetectorSettings(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ParsedClineTurnDetectorSettings> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return { settings: getDefaultClineTurnDetectorSettings(), warning: null };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...getDefaultClineTurnDetectorSettings(), mode: "report" },
			warning: `Could not read ${configPath} (${message}); the Cline turn detector only reports.`,
		};
	}
	try {
		return parseClineTurnDetectorSettings(JSON.parse(raw));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...getDefaultClineTurnDetectorSettings(), mode: "report" },
			warning: `Could not parse ${configPath} (${message}); the Cline turn detector only reports.`,
		};
	}
}

/** A settings loader that logs each distinct fallback warning once. */
export function createClineTurnDetectorSettingsLoader(
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<ClineTurnDetectorSettings> {
	let lastWarning: string | null = null;
	return async () => {
		const { settings, warning } = await readClineTurnDetectorSettings(configPath);
		if (warning && warning !== lastWarning) {
			warn(`[cline-turn-detector] ${warning}`);
		}
		lastWarning = warning;
		return settings;
	};
}
