// The one write Kanban makes in Cline's files on its own (issue #31, the user's choice 2026-10-11): each Lemonade
// model's `contextWindow` and `maxTokens` in Cline's models.json, kept equal to the `ctx_size` Lemonade loads the
// model with, so a model reloaded with another ctx_size reaches the next Cline session without the user's
// `kanban setup-provider lemonade`. Before, Cline compacted at the old size (a raised window) or sent more than
// llama-server takes, "Context size has been exceeded." (a lowered one, #26).
//
// Narrow on purpose. The comparison is doctor's and apply's (planLemonadeModelsForEntry); of its differences only
// these are written:
//   - contextWindow and maxTokens (maxTokens follows the window, maxTokensForContextWindow),
//   - of models already in the Lemonade entry's `models` record,
//   - when the window comes from Lemonade's `recipe_options.ctx_size`: the loaded model's (/health) or the recipe's
//     (/models). A global ctx_size or `max_context_window` (the model's maximum, not what it loads with) is skipped.
// The list form, dropping `modelsSourceUrl`, vision, reasoning, prices and every other key stay setup-provider
// lemonade; which models are in the record is the Kanban orchestrator's (never added or removed by either). The write is apply's: models.json as read is backed up into
// `<home>/backups/cline`, the file is left alone when it changed while Lemonade was asked, and it is replaced
// atomically with its own mode (cline-file-write.ts). A running Cline session keeps the window it started with.
import { readFile } from "node:fs/promises";

import type { LemonadeContextSource } from "../models/lemonade-models";
import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";
import {
	type LemonadeModelsOptions,
	type LemonadeModelsPlan,
	planLemonadeModelsForEntry,
	readStoredModels,
} from "./cline-lemonade-models";
import { readClineLemonadeEntry } from "./cline-models-source";

/** The keys the sync may write, nothing else. */
export const LEMONADE_CONTEXT_SYNC_KEYS = ["contextWindow", "maxTokens"] as const;

/** Windows that come from Lemonade's `recipe_options.ctx_size`. */
const SYNCED_CONTEXT_SOURCES: ReadonlySet<LemonadeContextSource> = new Set(["loaded", "recipe"]);

export interface LemonadeContextChange {
	id: string;
	contextWindow: { from: unknown; to: number };
	maxTokens: { from: unknown; to: number };
	/** The Lemonade value the window comes from: its `recipe_options.ctx_size`, of the loaded model or the recipe. */
	lemonade: { ctxSize: number; source: LemonadeContextSource };
}

export interface LemonadeContextSkip {
	id: string | null;
	reason: string;
}

export interface LemonadeContextSyncPlan {
	changes: LemonadeContextChange[];
	skipped: LemonadeContextSkip[];
	/** Differences left to setup-provider lemonade (other keys, the list form). */
	userDifferences: number;
}

function isSyncKey(key: string): boolean {
	return (LEMONADE_CONTEXT_SYNC_KEYS as readonly string[]).includes(key);
}

/** Which of doctor's differences the sync writes, which it skips and why, and how many are the user's. */
export function planLemonadeContextSync(plan: LemonadeModelsPlan): LemonadeContextSyncPlan {
	const { diff } = plan;
	const otherFields = diff.changed.reduce(
		(count, change) => count + change.fields.filter((field) => !isSyncKey(field.key)).length,
		0,
	);
	const userDifferences = (diff.listForm ? 1 : 0) + otherFields + (plan.defaultModel ? 1 : 0);
	const contextChanges = diff.changed.filter((change) => change.fields.some((field) => isSyncKey(field.key)));
	if (diff.listForm) {
		return {
			changes: [],
			skipped:
				contextChanges.length > 0
					? [{ id: null, reason: "models is a list, which only setup-provider lemonade rewrites" }]
					: [],
			userDifferences,
		};
	}
	const updates = new Map(plan.updates.map((update) => [update.id, update]));
	const changes: LemonadeContextChange[] = [];
	const skipped: LemonadeContextSkip[] = [];
	for (const { id, fields } of contextChanges) {
		const window = updates.get(id)?.contextWindow ?? null;
		const desired = plan.models[id];
		const to = { contextWindow: desired?.contextWindow, maxTokens: desired?.maxTokens };
		if (!window || !SYNCED_CONTEXT_SOURCES.has(window.source)) {
			skipped.push({
				id,
				reason: window
					? `its window would come from the ${window.source === "global" ? "global ctx_size" : "model's max_context_window"}, not its recipe_options.ctx_size`
					: "Lemonade reports no ctx_size for it",
			});
			continue;
		}
		if (typeof to.contextWindow !== "number" || typeof to.maxTokens !== "number") {
			skipped.push({ id, reason: "no wanted contextWindow/maxTokens" });
			continue;
		}
		const from = (key: keyof typeof to): unknown => {
			const field = fields.find((candidate) => candidate.key === key);
			return field ? field.from : to[key];
		};
		changes.push({
			id,
			contextWindow: { from: from("contextWindow"), to: to.contextWindow },
			maxTokens: { from: from("maxTokens"), to: to.maxTokens },
			lemonade: { ctxSize: window.tokens, source: window.source },
		});
	}
	return { changes, skipped, userDifferences };
}

export type LemonadeContextSyncMode = "on" | "report";

export interface LemonadeContextSyncOptions extends LemonadeModelsOptions {
	modelsPath: string;
	/** "report": plan only, write nothing. */
	mode: LemonadeContextSyncMode;
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	now?: Date;
}

export type LemonadeContextSyncStatus =
	/** No models.json, or no Lemonade provider in it. */
	| "absent"
	/** models.json can't be read or isn't a Cline models file. */
	| "unreadable"
	/** Lemonade didn't answer: nothing can be compared. */
	| "unreachable"
	/** No context window to change (other differences may be the user's). */
	| "in-sync"
	/** Only differences the sync doesn't write. */
	| "skipped"
	| "would-write"
	| "written"
	/** There were changes, but the write failed or the file changed meanwhile. */
	| "failed";

export interface LemonadeContextSyncResult extends LemonadeContextSyncPlan {
	status: LemonadeContextSyncStatus;
	modelsPath: string;
	/** The Lemonade API root asked, when the file had a Lemonade entry. */
	lemonadeApiBaseUrl: string | null;
	backupPath: string | null;
	/** Why the file couldn't be compared or written. */
	detail: string | null;
}

export async function syncClineLemonadeContextWindows(
	options: LemonadeContextSyncOptions,
): Promise<LemonadeContextSyncResult> {
	const empty: LemonadeContextSyncPlan = { changes: [], skipped: [], userDifferences: 0 };
	const base = { modelsPath: options.modelsPath, backupPath: null };
	const read = await readClineLemonadeEntry(options.modelsPath);
	if (read.kind !== "found") {
		return {
			...base,
			...empty,
			status: read.kind === "absent" ? "absent" : "unreadable",
			lemonadeApiBaseUrl: null,
			detail: read.detail,
		};
	}
	const plan = await planLemonadeModelsForEntry(read.entry, options);
	const result = { ...base, lemonadeApiBaseUrl: plan.apiBaseUrl, detail: null };
	if (plan.unreachable) {
		return { ...result, ...empty, status: "unreachable", detail: plan.unreachable };
	}
	const sync = planLemonadeContextSync(plan);
	if (sync.changes.length === 0) {
		return { ...result, ...sync, status: sync.skipped.length > 0 ? "skipped" : "in-sync" };
	}
	if (options.mode === "report") {
		return { ...result, ...sync, status: "would-write" };
	}
	try {
		// Lemonade may take seconds; never overwrite an edit made meanwhile.
		if ((await readFile(options.modelsPath, "utf8")) !== read.raw) {
			return {
				...result,
				...sync,
				status: "failed",
				detail: "models.json changed while Lemonade was asked; nothing written, the next sync compares again",
			};
		}
		const stored = readStoredModels(read.entry.models);
		if (stored.form !== "record") {
			return { ...result, ...sync, status: "failed", detail: "models is not a record by model id; nothing written" };
		}
		const models = read.entry.models as Record<string, unknown>;
		for (const change of sync.changes) {
			const entry = models[change.id];
			// readStoredModels made an object of a non-object entry; rewriting its form is the user's.
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				return {
					...result,
					...sync,
					status: "failed",
					detail: `${change.id}'s entry is not an object; nothing written`,
				};
			}
			models[change.id] = { ...entry, contextWindow: change.contextWindow.to, maxTokens: change.maxTokens.to };
		}
		const backupPath = await backupClineFile({
			path: options.modelsPath,
			raw: read.raw,
			backupDir: options.backupDir ?? getClineBackupDir(),
			now: options.now ?? new Date(),
		});
		await replaceClineFileAtomically(options.modelsPath, `${JSON.stringify(read.document, null, 2)}\n`);
		return { ...result, ...sync, status: "written", backupPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ...result, ...sync, status: "failed", detail: `could not write models.json: ${message}` };
	}
}
