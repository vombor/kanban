// Reads `models.lists.lemonade` and `models.lists.localai` from the global config.json: where the model-lists routes
// fetch each local provider's model list from, and what a model needs to be listed.
//
//   "models": { "lists": {
//     "lemonade": { "url": "http://localhost:13305", "requireLabels": ["tool-calling"] },
//     "localai": { "url": "http://localai.example.ts.net", "requireCapabilities": ["chat"] } } }
//
// `url` is Lemonade's base URL (the route appends /api/v1/models), or LocalAI's root URL (the route appends /v1/...).
// LocalAI has no default URL, since it runs wherever the user put it: an unset `url` means the baseUrl of Cline's
// `localai` provider, the one `kanban cline apply-localai-provider` writes (resolveLocalAiUrl in
// src/setup/cline-localai-provider.ts). The file is read on every request, so edits apply without a restart. A
// missing file or key means the defaults; a value of the wrong type is ignored with a warning (logged once per
// distinct problem) and its default is used.
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getKanbanGlobalConfigPath } from "../state/kanban-home";

export interface LemonadeModelListSettings {
	/** Lemonade's base URL, without /api/v1. */
	url: string;
	/** A model is listed only when it has every one of these labels. */
	requireLabels: string[];
}

export const DEFAULT_LEMONADE_MODEL_LIST_SETTINGS: LemonadeModelListSettings = {
	url: "http://localhost:13305",
	requireLabels: ["tool-calling"],
};

export interface LocalAiModelListSettings {
	/** LocalAI's root URL (without /v1); null = the baseUrl of Cline's `localai` provider. */
	url: string | null;
	/** A model is listed only when LocalAI reports every one of these capabilities. */
	requireCapabilities: string[];
}

export const DEFAULT_LOCALAI_MODEL_LIST_SETTINGS: LocalAiModelListSettings = {
	url: null,
	requireCapabilities: ["chat"],
};

export interface ParsedModelListSettings<T> {
	settings: T;
	/** Why a configured value was ignored, if one was. */
	warning: string | null;
}

export type ParsedLemonadeModelListSettings = ParsedModelListSettings<LemonadeModelListSettings>;
export type ParsedLocalAiModelListSettings = ParsedModelListSettings<LocalAiModelListSettings>;

const httpUrlSchema = z.url({ protocol: /^https?$/u });
const namesSchema = z.array(z.string().trim().min(1));

function readObjectKey(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function readList(config: unknown, provider: string): unknown {
	return readObjectKey(readObjectKey(readObjectKey(config, "models"), "lists"), provider);
}

function joinWarnings(warnings: string[]): string | null {
	return warnings.length > 0 ? `${warnings.join("; ")}; using the default.` : null;
}

function defaultLemonadeSettings(): LemonadeModelListSettings {
	return {
		...DEFAULT_LEMONADE_MODEL_LIST_SETTINGS,
		requireLabels: [...DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.requireLabels],
	};
}

function defaultLocalAiSettings(): LocalAiModelListSettings {
	return {
		...DEFAULT_LOCALAI_MODEL_LIST_SETTINGS,
		requireCapabilities: [...DEFAULT_LOCALAI_MODEL_LIST_SETTINGS.requireCapabilities],
	};
}

export function parseLemonadeModelListSettings(config: unknown): ParsedLemonadeModelListSettings {
	const lemonade = readList(config, "lemonade");
	const rawUrl = readObjectKey(lemonade, "url");
	const rawLabels = readObjectKey(lemonade, "requireLabels");
	const url = httpUrlSchema.safeParse(rawUrl);
	const labels = namesSchema.safeParse(rawLabels);
	const warnings: string[] = [];
	if (rawUrl !== undefined && !url.success) {
		warnings.push(`models.lists.lemonade.url ${JSON.stringify(rawUrl)} is not an http(s) URL`);
	}
	if (rawLabels !== undefined && !labels.success) {
		warnings.push(`models.lists.lemonade.requireLabels ${JSON.stringify(rawLabels)} is not a list of labels`);
	}
	const defaults = defaultLemonadeSettings();
	return {
		settings: {
			url: url.success ? url.data : defaults.url,
			requireLabels: labels.success ? labels.data : defaults.requireLabels,
		},
		warning: joinWarnings(warnings),
	};
}

export function parseLocalAiModelListSettings(config: unknown): ParsedLocalAiModelListSettings {
	const localai = readList(config, "localai");
	const rawUrl = readObjectKey(localai, "url");
	const rawCapabilities = readObjectKey(localai, "requireCapabilities");
	const url = httpUrlSchema.safeParse(rawUrl);
	const capabilities = namesSchema.safeParse(rawCapabilities);
	const warnings: string[] = [];
	if (rawUrl !== undefined && rawUrl !== null && !url.success) {
		warnings.push(`models.lists.localai.url ${JSON.stringify(rawUrl)} is not an http(s) URL`);
	}
	if (rawCapabilities !== undefined && !capabilities.success) {
		warnings.push(
			`models.lists.localai.requireCapabilities ${JSON.stringify(rawCapabilities)} is not a list of capabilities`,
		);
	}
	const defaults = defaultLocalAiSettings();
	return {
		settings: {
			url: url.success ? url.data : defaults.url,
			requireCapabilities: capabilities.success ? capabilities.data : defaults.requireCapabilities,
		},
		warning: joinWarnings(warnings),
	};
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readModelListSettings<T>(
	configPath: string,
	parse: (config: unknown) => ParsedModelListSettings<T>,
	defaults: () => T,
): Promise<ParsedModelListSettings<T>> {
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
		return parse(JSON.parse(raw));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { settings: defaults(), warning: `Could not parse ${configPath} (${message}); using the defaults.` };
	}
}

export async function readLemonadeModelListSettings(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ParsedLemonadeModelListSettings> {
	return await readModelListSettings(configPath, parseLemonadeModelListSettings, defaultLemonadeSettings);
}

export async function readLocalAiModelListSettings(
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ParsedLocalAiModelListSettings> {
	return await readModelListSettings(configPath, parseLocalAiModelListSettings, defaultLocalAiSettings);
}

function createSettingsLoader<T>(
	read: (configPath?: string) => Promise<ParsedModelListSettings<T>>,
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<T> {
	let lastWarning: string | null = null;
	return async () => {
		const { settings, warning } = await read(configPath);
		if (warning && warning !== lastWarning) {
			warn(`[model-lists] ${warning}`);
		}
		lastWarning = warning;
		return settings;
	};
}

/** A settings loader for the model-lists route that logs each distinct warning once. */
export function createLemonadeModelListSettingsLoader(
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<LemonadeModelListSettings> {
	return createSettingsLoader(readLemonadeModelListSettings, warn, configPath);
}

/** The LocalAI route's settings loader, logging each distinct warning once. */
export function createLocalAiModelListSettingsLoader(
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<LocalAiModelListSettings> {
	return createSettingsLoader(readLocalAiModelListSettings, warn, configPath);
}
