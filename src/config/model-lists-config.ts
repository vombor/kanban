// Reads `models.lists.lemonade` from the global config.json: where the model-lists route fetches Lemonade's
// model list from, and which labels a model needs to be listed.
//
//   "models": { "lists": { "lemonade": { "url": "http://localhost:13305", "requireLabels": ["tool-calling"],
//     "include": ["<model id>", ...] } } }
//
// `include` is the user's choice of models the model-lists route lists (2026-10-12; the models stay installed on
// Lemonade): absent (or null) means every model that passes the other rules, a list means only those ids, and only
// while they still pass them. The user sets it with `kanban config set models.lists.lemonade.include <ids...>`
// (src/config/model-list-include-setting.ts).
//
// `url` is Lemonade's base URL (the route appends /api/v1/models). The file is read on every request, so edits
// apply without a restart. A missing file or key means the defaults; a value of the wrong type is ignored with a
// warning (logged once per distinct problem) and its default is used.
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getKanbanGlobalConfigPath } from "../state/kanban-home";

export interface LemonadeModelListSettings {
	/** Lemonade's base URL, without /api/v1. */
	url: string;
	/** A model is listed only when it has every one of these labels. */
	requireLabels: string[];
	/** Only these model ids are listed; null = every model that passes the other rules. */
	include: string[] | null;
}

export const DEFAULT_LEMONADE_MODEL_LIST_SETTINGS: LemonadeModelListSettings = {
	url: "http://localhost:13305",
	requireLabels: ["tool-calling"],
	include: null,
};

export interface ParsedLemonadeModelListSettings {
	settings: LemonadeModelListSettings;
	/** Why a configured value was ignored, if one was. */
	warning: string | null;
}

const httpUrlSchema = z.url({ protocol: /^https?$/u });
const labelsSchema = z.array(z.string().trim().min(1));
// An empty list would offer no model at all; removing the key is how every model comes back.
export const modelListIncludeSchema = z.array(z.string().trim().min(1)).min(1).nullable();

export const LEMONADE_MODEL_LIST_INCLUDE_KEY = "models.lists.lemonade.include";

/** Whether `id` passes a list's `include` (null = every id). */
export function isIncludedModelId(id: string, include: readonly string[] | null): boolean {
	return include === null || include.includes(id);
}

function readObjectKey(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export function parseLemonadeModelListSettings(config: unknown): ParsedLemonadeModelListSettings {
	const lemonade = readObjectKey(readObjectKey(readObjectKey(config, "models"), "lists"), "lemonade");
	const rawUrl = readObjectKey(lemonade, "url");
	const rawLabels = readObjectKey(lemonade, "requireLabels");
	const url = httpUrlSchema.safeParse(rawUrl);
	const labels = labelsSchema.safeParse(rawLabels);
	const warnings: string[] = [];
	if (rawUrl !== undefined && !url.success) {
		warnings.push(`models.lists.lemonade.url ${JSON.stringify(rawUrl)} is not an http(s) URL`);
	}
	if (rawLabels !== undefined && !labels.success) {
		warnings.push(`models.lists.lemonade.requireLabels ${JSON.stringify(rawLabels)} is not a list of labels`);
	}
	const rawInclude = readObjectKey(lemonade, "include");
	const include = modelListIncludeSchema.safeParse(rawInclude ?? null);
	if (!include.success) {
		warnings.push(
			`${LEMONADE_MODEL_LIST_INCLUDE_KEY} ${JSON.stringify(rawInclude)} is not a non-empty list of model ids`,
		);
	}
	return {
		settings: {
			url: url.success ? url.data : DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.url,
			requireLabels: labels.success ? labels.data : [...DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.requireLabels],
			include: include.success && include.data ? [...new Set(include.data)] : null,
		},
		warning: warnings.length > 0 ? `${warnings.join("; ")}; using the default.` : null,
	};
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function readLemonadeModelListSettings(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ParsedLemonadeModelListSettings> {
	const defaults = (): LemonadeModelListSettings => ({
		...DEFAULT_LEMONADE_MODEL_LIST_SETTINGS,
		requireLabels: [...DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.requireLabels],
	});
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return { settings: defaults(), warning: null };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { settings: defaults(), warning: `Could not read ${configPath} (${message}); using the defaults.` };
	}
	try {
		return parseLemonadeModelListSettings(JSON.parse(raw));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { settings: defaults(), warning: `Could not parse ${configPath} (${message}); using the defaults.` };
	}
}

/** A settings loader for the model-lists route that logs each distinct warning once. */
export function createLemonadeModelListSettingsLoader(
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<LemonadeModelListSettings> {
	let lastWarning: string | null = null;
	return async () => {
		const { settings, warning } = await readLemonadeModelListSettings(configPath);
		if (warning && warning !== lastWarning) {
			warn(`[model-lists] ${warning}`);
		}
		lastWarning = warning;
		return settings;
	};
}
