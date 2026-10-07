// Reads `sessionSync` from the global config.json: whether the runtime moves cards between In Progress and Review
// (src/server/session-column-sync.ts) instead of the browser.
//
//   "sessionSync": false
//
// Default true in this fork. Read once when the server starts, and the same value goes to the server's session
// sync and to the browser (`sessionSyncEnabled` in the runtime config response), so the two can never both move
// cards or both leave them. A change applies at the next restart (docs/fork/session-sync.md). The settings dialog
// never writes the key, and runtime-config.ts keeps keys it doesn't manage. A config.json that can't be read or
// parsed, or a value that isn't a boolean, gives the default and a warning.
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getKanbanGlobalConfigPath } from "../state/kanban-home";

export const DEFAULT_SESSION_SYNC_ENABLED = true;

export interface SessionSyncSetting {
	enabled: boolean;
	/** Why the default was used although config.json has (or may have) a value. */
	warning: string | null;
}

export function parseSessionSyncSetting(config: unknown): SessionSyncSetting {
	const raw =
		config && typeof config === "object" && !Array.isArray(config)
			? (config as Record<string, unknown>).sessionSync
			: undefined;
	if (raw === undefined) {
		return { enabled: DEFAULT_SESSION_SYNC_ENABLED, warning: null };
	}
	const parsed = z.boolean().safeParse(raw);
	if (parsed.success) {
		return { enabled: parsed.data, warning: null };
	}
	return {
		enabled: DEFAULT_SESSION_SYNC_ENABLED,
		warning: `sessionSync ${JSON.stringify(raw)} is not true or false; using ${DEFAULT_SESSION_SYNC_ENABLED}.`,
	};
}

export async function readSessionSyncSetting(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<SessionSyncSetting> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { enabled: DEFAULT_SESSION_SYNC_ENABLED, warning: null };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			enabled: DEFAULT_SESSION_SYNC_ENABLED,
			warning: `Could not read ${configPath} (${message}); sessionSync is ${DEFAULT_SESSION_SYNC_ENABLED}.`,
		};
	}
	try {
		return parseSessionSyncSetting(JSON.parse(raw));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			enabled: DEFAULT_SESSION_SYNC_ENABLED,
			warning: `Could not parse ${configPath} (${message}); sessionSync is ${DEFAULT_SESSION_SYNC_ENABLED}.`,
		};
	}
}
