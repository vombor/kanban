// Reads `sessionSync` from the global config.json: whether the runtime moves cards between In Progress and Review
// (src/server/session-column-sync.ts) instead of the browser.
//
//   "sessionSync": { "enabled": false, "reviewSettleSec": 12 }
//
// `reviewSettleSec` is the review settle rule's period (src/terminal/review-settle.ts), read with `enabled` and
// passed to the auto-review reconciler and, in every snapshot, to the pipeline worker, so both use one value.
//
// The key is a core settings section (`sessionSyncSectionSchema` in pipeline-config.ts, the one schema for it).
// P2-1's top-level boolean (`"sessionSync": false`) still reads the same; `kanban doctor --fix` rewrites it.
//
// Default true in this fork. Read once when the server starts, and the same value goes to the server's session
// sync and to the browser (`sessionSyncEnabled` in the runtime config response), so the two can never both move
// cards or both leave them. A change applies at the next restart (docs/fork/session-sync.md). The settings dialog
// never writes the key, and runtime-config.ts keeps keys it doesn't manage. A config.json that can't be read or
// parsed, or a value that doesn't validate, gives the default and a warning.
import { readFile } from "node:fs/promises";

import { getKanbanGlobalConfigPath } from "../state/kanban-home";
import { DEFAULT_REVIEW_SETTLE_MS } from "../terminal/review-settle";
import { DEFAULT_SESSION_SYNC_ENABLED, sessionSyncSectionSchema } from "./pipeline-config";

export { DEFAULT_SESSION_SYNC_ENABLED };

export interface SessionSyncSetting {
	enabled: boolean;
	/** `reviewSettleSec` in ms. */
	reviewSettleMs: number;
	/** Why the default was used although config.json has (or may have) a value. */
	warning: string | null;
}

export function parseSessionSyncSetting(config: unknown): SessionSyncSetting {
	const raw =
		config && typeof config === "object" && !Array.isArray(config)
			? (config as Record<string, unknown>).sessionSync
			: undefined;
	if (raw === undefined) {
		return { enabled: DEFAULT_SESSION_SYNC_ENABLED, reviewSettleMs: DEFAULT_REVIEW_SETTLE_MS, warning: null };
	}
	const parsed = sessionSyncSectionSchema.safeParse(raw);
	if (parsed.success) {
		return { enabled: parsed.data.enabled, reviewSettleMs: parsed.data.reviewSettleSec * 1000, warning: null };
	}
	return {
		enabled: DEFAULT_SESSION_SYNC_ENABLED,
		reviewSettleMs: DEFAULT_REVIEW_SETTLE_MS,
		warning: `sessionSync ${JSON.stringify(raw)} is not { "enabled": true | false, "reviewSettleSec": 0-600 } (or the old true / false); using ${DEFAULT_SESSION_SYNC_ENABLED}.`,
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
			return { enabled: DEFAULT_SESSION_SYNC_ENABLED, reviewSettleMs: DEFAULT_REVIEW_SETTLE_MS, warning: null };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			enabled: DEFAULT_SESSION_SYNC_ENABLED,
			reviewSettleMs: DEFAULT_REVIEW_SETTLE_MS,
			warning: `Could not read ${configPath} (${message}); sessionSync is ${DEFAULT_SESSION_SYNC_ENABLED}.`,
		};
	}
	try {
		return parseSessionSyncSetting(JSON.parse(raw));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			enabled: DEFAULT_SESSION_SYNC_ENABLED,
			reviewSettleMs: DEFAULT_REVIEW_SETTLE_MS,
			warning: `Could not parse ${configPath} (${message}); sessionSync is ${DEFAULT_SESSION_SYNC_ENABLED}.`,
		};
	}
}
