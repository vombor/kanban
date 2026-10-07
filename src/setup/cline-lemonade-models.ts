// `kanban setup` step: per-model metadata for the Lemonade provider in Cline's models.json.
//
// Without it every Lemonade model runs on Cline's defaults (research, 2026-10-07): a 128K context window, so
// compaction starts at 0.9 x 128K, too early for GLM-4.7-Flash (202,752) and Devstral (131,072), and no vision, so
// images reach the model as placeholders. Facts from cline 3.0.69 (@cline/core dist, same code in the bun CLI):
//   - `providers.<id>.models` is a record by model id (`StoredProviderEntrySchema`) whose entries take
//     contextWindow, maxTokens, maxInputTokens, supportsVision, supportsReasoning, inputPrice/outputPrice and more
//     (`StoredModelEntrySchema`). A provider entry that fails the schema is dropped whole ("models.json: dropping
//     invalid entry for provider=lemonade"), and a `models` list fails it, so a list is rewritten as a record.
//   - Each entry becomes the model's info (`gx`): supportsVision adds the "images" capability, supportsReasoning
//     "reasoning". An entry without contextWindow gets the 128K default; compaction triggers at 0.9 x the window.
//   - The output budget is min(maxTokens, window - input - 1024), so maxTokens can't push a request past the window.
//   - `modelsSourceUrl` only ever yields ids (`extractModelIdsFromPayload`), so the metadata can't ride on the
//     model-lists route; it has to be in models.json.
// For every model Lemonade lists (downloaded, with the route's required labels) this sets contextWindow (see
// src/models/lemonade-models.ts for where the size comes from), maxTokens, supportsVision and supportsReasoning,
// adds the model when it's missing, and sets zero prices when none are set. Every other key and model is kept.
// With Lemonade down no value changes (only a list is still rewritten as a record) and the step says so.
import { DEFAULT_LEMONADE_MODEL_LIST_SETTINGS } from "../config/model-lists-config";
import {
	fetchLemonadeCatalog,
	isListedLemonadeModel,
	type LemonadeCatalog,
	type LemonadeContextSource,
	type LemonadeContextWindow,
	lemonadeApiBaseUrl,
	resolveLemonadeContextWindow,
} from "../models/lemonade-models";
import { readClineLemonadeEntry, writeClineModelsFile } from "./cline-models-source";

/** Cline's window for a model whose entry has none (@cline/core `RE`/`OY` = 128000). */
export const CLINE_DEFAULT_CONTEXT_WINDOW = 128_000;

const MAX_OUTPUT_TOKENS = 32_768;

const CONTEXT_SOURCE_LABELS: Record<LemonadeContextSource, string> = {
	loaded: "loaded ctx_size",
	recipe: "recipe ctx_size",
	global: "global ctx_size",
	"model-max": "model max; Lemonade auto-tunes up to it",
};

/** A quarter of the window, at most 32K: room for long tool calls without starving the prompt on small windows. */
export function maxTokensForContextWindow(contextWindow: number): number {
	return Math.max(1, Math.min(MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4)));
}

export type StoredModelEntry = Record<string, unknown>;
export type StoredModels = Record<string, StoredModelEntry>;

export interface StoredModelsRead {
	models: StoredModels;
	/** `list`: the pre-3.x form cline 3.0.69 rejects. */
	form: "record" | "list" | "missing";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The provider's `models` as a record by id, whichever form it was written in. */
export function readStoredModels(value: unknown): StoredModelsRead {
	if (Array.isArray(value)) {
		const models: StoredModels = {};
		for (const item of value) {
			const id =
				typeof item === "string" ? item.trim() : isObject(item) && typeof item.id === "string" ? item.id : "";
			if (id) {
				models[id] = isObject(item) ? { ...item } : { id, name: id };
			}
		}
		return { models, form: "list" };
	}
	if (isObject(value)) {
		const models: StoredModels = {};
		for (const [id, entry] of Object.entries(value)) {
			models[id] = isObject(entry) ? { ...entry } : { id, name: id };
		}
		return { models, form: "record" };
	}
	return { models: {}, form: "missing" };
}

/** A positive contextWindow in a stored entry, or null (Cline then uses its 128K default). */
export function storedContextWindow(entry: StoredModelEntry): number | null {
	const value = entry.contextWindow;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export interface LemonadeModelUpdate {
	id: string;
	added: boolean;
	contextWindow: LemonadeContextWindow | null;
	vision: boolean;
	reasoning: boolean;
}

/** `current` with Lemonade's metadata for every listed model; with no catalog only the form changes. */
export function mergeLemonadeModelMetadata(
	current: StoredModels,
	catalog: LemonadeCatalog | null,
	requireLabels: readonly string[],
): { models: StoredModels; updates: LemonadeModelUpdate[] } {
	const models: StoredModels = { ...current };
	const updates: LemonadeModelUpdate[] = [];
	if (!catalog) {
		return { models, updates };
	}
	for (const model of catalog.models) {
		if (!isListedLemonadeModel(model, requireLabels)) {
			continue;
		}
		const existing = current[model.id];
		const next: StoredModelEntry = {
			...existing,
			id: model.id,
			name: typeof existing?.name === "string" ? existing.name : model.id,
		};
		const contextWindow = resolveLemonadeContextWindow(model, catalog);
		if (contextWindow) {
			next.contextWindow = contextWindow.tokens;
			next.maxTokens = maxTokensForContextWindow(contextWindow.tokens);
		}
		const vision = model.labels.includes("vision");
		const reasoning = model.labels.includes("reasoning");
		next.supportsVision = vision;
		next.supportsReasoning = reasoning;
		next.inputPrice ??= 0;
		next.outputPrice ??= 0;
		models[model.id] = next;
		updates.push({ id: model.id, added: existing === undefined, contextWindow, vision, reasoning });
	}
	return { models, updates };
}

function describeUpdate(update: LemonadeModelUpdate, entry: StoredModelEntry | undefined): string {
	const features = [update.vision ? "vision" : null, update.reasoning ? "reasoning" : null].filter(Boolean);
	const context = update.contextWindow
		? `context ${update.contextWindow.tokens} (${CONTEXT_SOURCE_LABELS[update.contextWindow.source]}), maxTokens ${entry?.maxTokens}`
		: `no context info from Lemonade; ${entry && storedContextWindow(entry) !== null ? `keeps context ${entry.contextWindow}` : `Cline's ${CLINE_DEFAULT_CONTEXT_WINDOW} default`}`;
	return `${update.id}${update.added ? " (added)" : ""}: ${context}${features.length > 0 ? `, ${features.join(", ")}` : ""}`;
}

export type ClineLemonadeModelsAction =
	/** No models.json, or no Lemonade provider in it. */
	| "skip"
	| "up-to-date"
	| "update"
	/** Lemonade didn't answer and the file needs no rewrite; nothing changes. */
	| "unreachable"
	| "error";

export interface ClineLemonadeModelsPlan {
	action: ClineLemonadeModelsAction;
	details: string[];
	/** Present for `update`. Re-reads the file (another setup step may have written it) and returns what it wrote. */
	apply?: () => Promise<string[]>;
}

export interface ClineLemonadeModelsOptions {
	modelsPath: string;
	/** The model-lists route's labels (`models.lists.lemonade.requireLabels`), so both offer the same models. */
	requireLabels: readonly string[];
	/** Lemonade's base URL when the provider entry has no baseUrl (`models.lists.lemonade.url`). */
	lemonadeUrl?: string;
	fetch?: typeof fetch;
	now?: Date;
}

function apiBaseUrlFor(entry: Record<string, unknown>, fallbackUrl: string): string {
	const provider = isObject(entry.provider) ? entry.provider : {};
	const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
	// Cline talks to the provider's baseUrl (Lemonade's /api/v1), so the metadata comes from the same server.
	return baseUrl || lemonadeApiBaseUrl(fallbackUrl);
}

export async function planClineLemonadeModels(options: ClineLemonadeModelsOptions): Promise<ClineLemonadeModelsPlan> {
	const read = await readClineLemonadeEntry(options.modelsPath);
	if (read.kind !== "found") {
		return { action: read.kind === "absent" ? "skip" : "error", details: [read.detail] };
	}
	const apiBaseUrl = apiBaseUrlFor(read.entry, options.lemonadeUrl ?? DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.url);
	let catalog: LemonadeCatalog | null = null;
	let unreachable: string | null = null;
	try {
		catalog = await fetchLemonadeCatalog(apiBaseUrl, options.fetch);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		unreachable = `Lemonade at ${apiBaseUrl} did not answer (${message}); existing model values kept`;
	}
	const merge = (entryModels: unknown) => {
		const stored = readStoredModels(entryModels);
		return { stored, ...mergeLemonadeModelMetadata(stored.models, catalog, options.requireLabels) };
	};
	const { stored, models, updates } = merge(read.entry.models);
	const changed = JSON.stringify(models) !== JSON.stringify(read.entry.models ?? {});
	const details = [
		...(unreachable ? [unreachable] : []),
		...(stored.form === "list"
			? ["models is a list, which cline 3.x rejects (it drops the provider): rewrite as a record by id"]
			: []),
		...updates.map((update) => describeUpdate(update, models[update.id])),
	];
	if (catalog && updates.length === 0) {
		details.push(`Lemonade lists no downloaded model with labels ${options.requireLabels.join(", ") || "(none)"}`);
	}
	if (!changed) {
		return unreachable ? { action: "unreachable", details } : { action: "up-to-date", details };
	}
	return {
		action: "update",
		details,
		apply: async () => {
			const current = await readClineLemonadeEntry(options.modelsPath);
			if (current.kind !== "found") {
				throw new Error(current.detail);
			}
			const next = merge(current.entry.models).models;
			if (JSON.stringify(next) === JSON.stringify(current.entry.models ?? {})) {
				return ["lemonade models already current"];
			}
			current.entry.models = next;
			const backupPath = await writeClineModelsFile(
				options.modelsPath,
				current.raw,
				current.document,
				options.now ?? new Date(),
			);
			return [`lemonade models: wrote metadata for ${updates.length} model(s)`, `backup: ${backupPath}`];
		},
	};
}
