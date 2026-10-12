// What the Lemonade provider's per-model metadata in Cline's models.json should be, compared with what it is.
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
// The record is the allow list (docs/team/MODELS.md): Cline offers only the models in it, and the Kanban orchestrator
// curates it by hand with models that passed `kanban models vet`. So the wanted record has exactly the models the
// file has, never one more or one less; of those Lemonade lists, the metadata is refreshed: contextWindow (see
// src/models/lemonade-models.ts for where the size comes from), maxTokens, supportsVision and supportsReasoning, and
// zero prices when none are set; other keys of a model are kept. A model Lemonade doesn't list is kept as it is and
// reported. A `provider.defaultModelId` that isn't in the record becomes the record's first model (the record is what
// Cline offers). With Lemonade down no value changes (only a list is still rewritten as a record). Another provider type
// in the setup-provider registry follows the same rule: keep the records it finds, only fill in their metadata.
// Read-only: `kanban setup` and doctor print the differences, and `kanban setup-provider lemonade` (run by the user
// or the Kanban orchestrator, cline-lemonade-apply.ts) writes them. The one exception is the server's context sync
// (cline-lemonade-context-sync.ts, issue #31): from this same plan it writes only contextWindow and maxTokens of
// models already in the file.
import { DEFAULT_LEMONADE_MODEL_LIST_SETTINGS } from "../config/model-lists-config";
import {
	fetchLemonadeCatalog,
	type LemonadeCatalog,
	type LemonadeContextSource,
	type LemonadeContextWindow,
	lemonadeApiBaseUrl,
	resolveLemonadeContextWindow,
} from "../models/lemonade-models";
import { readClineLemonadeEntry } from "./cline-models-source";

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
	contextWindow: LemonadeContextWindow | null;
	vision: boolean;
	reasoning: boolean;
}

/**
 * The wanted record: the models of `current`, each one Lemonade lists with Lemonade's metadata; with no catalog,
 * `current`. `unlisted` are the record's models Lemonade doesn't list (kept unchanged).
 */
export function buildDesiredLemonadeModels(
	current: StoredModels,
	catalog: LemonadeCatalog | null,
): { models: StoredModels; updates: LemonadeModelUpdate[]; unlisted: string[] } {
	if (!catalog) {
		return { models: { ...current }, updates: [], unlisted: [] };
	}
	const byId = new Map(catalog.models.map((model) => [model.id, model]));
	const models: StoredModels = {};
	const updates: LemonadeModelUpdate[] = [];
	const unlisted: string[] = [];
	for (const [id, existing] of Object.entries(current)) {
		const model = byId.get(id);
		if (!model) {
			models[id] = { ...existing };
			unlisted.push(id);
			continue;
		}
		const next: StoredModelEntry = {
			...existing,
			id: model.id,
			name: typeof existing.name === "string" ? existing.name : model.id,
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
		updates.push({ id: model.id, contextWindow, vision, reasoning });
	}
	return { models, updates, unlisted };
}

export interface LemonadeFieldChange {
	key: string;
	from: unknown;
	to: unknown;
}

/** Only metadata changes: the record's models are the orchestrator's, never added or removed here. */
export interface LemonadeModelsDiff {
	/** The file has the list form cline 3.x rejects. */
	listForm: boolean;
	changed: Array<{ id: string; fields: LemonadeFieldChange[] }>;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function diffLemonadeModels(stored: StoredModelsRead, desired: StoredModels): LemonadeModelsDiff {
	const changed: LemonadeModelsDiff["changed"] = [];
	for (const [id, next] of Object.entries(desired)) {
		const current = stored.models[id];
		if (!current) {
			continue;
		}
		const keys = [...new Set([...Object.keys(current), ...Object.keys(next)])];
		const fields = keys
			.filter((key) => !sameJson(current[key], next[key]))
			.map((key) => ({ key, from: current[key], to: next[key] }));
		if (fields.length > 0) {
			changed.push({ id, fields });
		}
	}
	return { listForm: stored.form === "list", changed };
}

export function isLemonadeModelsDiffEmpty(diff: LemonadeModelsDiff): boolean {
	return !diff.listForm && diff.changed.length === 0;
}

function formatValue(value: unknown): string {
	return value === undefined ? "(unset)" : JSON.stringify(value);
}

function describeChange(id: string, fields: LemonadeFieldChange[], update: LemonadeModelUpdate | undefined): string {
	const parts = fields.map((field) => {
		const source =
			field.key === "contextWindow" && update?.contextWindow
				? ` (${CONTEXT_SOURCE_LABELS[update.contextWindow.source]})`
				: "";
		return `${field.key} ${formatValue(field.from)} -> ${formatValue(field.to)}${source}`;
	});
	return `${id}: ${parts.join(", ")}`;
}

/** One line per difference. */
export function describeLemonadeModelsDiff(
	diff: LemonadeModelsDiff,
	updates: readonly LemonadeModelUpdate[],
): string[] {
	const updateById = new Map(updates.map((update) => [update.id, update]));
	return [
		...(diff.listForm
			? ["models is a list, which cline 3.x rejects (it drops the provider): rewrite as a record by id"]
			: []),
		...diff.changed.map(({ id, fields }) => describeChange(id, fields, updateById.get(id))),
	];
}

/** The line about the record's models Lemonade doesn't list, or null. */
export function describeUnlistedLemonadeModels(unlisted: readonly string[]): string | null {
	return unlisted.length > 0
		? `${unlisted.join(", ")}: in the models record but Lemonade doesn't list it (kept; a card on it fails until Lemonade has it or the orchestrator takes it out of models.json)`
		: null;
}

function describeInSync(models: StoredModels): string {
	const entries = Object.entries(models);
	if (entries.length === 0) {
		return "no models";
	}
	return `${entries.length} model(s) in sync: ${entries
		.map(([id, entry]) => `${id} ${storedContextWindow(entry) ?? `${CLINE_DEFAULT_CONTEXT_WINDOW} (Cline default)`}`)
		.join(", ")}`;
}

export interface LemonadeDefaultModelChange {
	from: string;
	to: string;
}

/**
 * A `provider.defaultModelId` that isn't in the record becomes the record's first model. Null when it is in the
 * record, unset, or the record is empty.
 */
export function planLemonadeDefaultModel(current: unknown, models: StoredModels): LemonadeDefaultModelChange | null {
	const from = typeof current === "string" ? current : null;
	const to = Object.keys(models)[0];
	return from === null || !to || from in models ? null : { from, to };
}

export interface LemonadeModelsPlan {
	/** Lemonade answered and its models are already in the file. */
	inSync: boolean;
	/** Lemonade didn't answer (the wanted record is then the file's own, as a record). */
	unreachable: string | null;
	diff: LemonadeModelsDiff;
	/** `provider.defaultModelId` to change, when it isn't in the record. */
	defaultModel: LemonadeDefaultModelChange | null;
	/** The wanted `providers.lemonade.models`. */
	models: StoredModels;
	/** What Lemonade said about each of the record's models it lists (empty when it didn't answer). */
	updates: LemonadeModelUpdate[];
	/** The record's models Lemonade doesn't list (empty when it didn't answer). */
	unlisted: string[];
	/** The Lemonade API root the values come from. */
	apiBaseUrl: string;
	/** What is in sync, what would change, or why nothing can be compared. */
	details: string[];
}

export interface LemonadeModelsOptions {
	/** Lemonade's base URL when the provider entry has no baseUrl (`models.lists.lemonade.url`). */
	lemonadeUrl?: string;
	fetch?: typeof fetch;
	/** Per Lemonade request (default: lemonade-models.ts's). Doctor keeps it short. */
	timeoutMs?: number;
}

function apiBaseUrlFor(entry: Record<string, unknown>, fallbackUrl: string): string {
	const provider = isObject(entry.provider) ? entry.provider : {};
	const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
	// Cline talks to the provider's baseUrl (Lemonade's /api/v1), so the metadata comes from the same server.
	return baseUrl || lemonadeApiBaseUrl(fallbackUrl);
}

/** Compares a Lemonade provider entry's `models` with what Lemonade reports now. Never writes. */
export async function planLemonadeModelsForEntry(
	entry: Record<string, unknown>,
	options: LemonadeModelsOptions,
): Promise<LemonadeModelsPlan> {
	const apiBaseUrl = apiBaseUrlFor(entry, options.lemonadeUrl ?? DEFAULT_LEMONADE_MODEL_LIST_SETTINGS.url);
	let catalog: LemonadeCatalog | null = null;
	let unreachable: string | null = null;
	try {
		catalog = await fetchLemonadeCatalog(apiBaseUrl, options.fetch, options.timeoutMs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		unreachable = `Lemonade at ${apiBaseUrl} did not answer (${message}); model values can't be compared`;
	}
	const stored = readStoredModels(entry.models);
	const { models, updates, unlisted } = buildDesiredLemonadeModels(stored.models, catalog);
	const diff = diffLemonadeModels(stored, models);
	const provider = isObject(entry.provider) ? entry.provider : {};
	const defaultModel = planLemonadeDefaultModel(provider.defaultModelId, models);
	const empty = isLemonadeModelsDiffEmpty(diff) && defaultModel === null;
	const unlistedLine = describeUnlistedLemonadeModels(unlisted);
	const details = [
		...(unreachable ? [unreachable] : []),
		...describeLemonadeModelsDiff(diff, updates),
		...(defaultModel
			? [
					`defaultModelId: ${defaultModel.from} -> ${defaultModel.to} (${defaultModel.from} is not in the models record)`,
				]
			: []),
		...(unlistedLine ? [unlistedLine] : []),
		...(catalog && empty ? [describeInSync(models)] : []),
	];
	return {
		inSync: catalog !== null && empty,
		unreachable,
		diff,
		defaultModel,
		models,
		updates,
		unlisted,
		apiBaseUrl,
		details,
	};
}

/** Whether applying the plan changes the entry's models or its defaultModelId. */
export function hasLemonadeModelsChanges(plan: Pick<LemonadeModelsPlan, "diff" | "defaultModel">): boolean {
	return !isLemonadeModelsDiffEmpty(plan.diff) || plan.defaultModel !== null;
}

export type ClineLemonadeModelsPlan =
	/** No models.json, or no Lemonade provider in it; or a file that can't be read. */
	{ kind: "absent" | "error"; details: string[] } | ({ kind: "found" } & LemonadeModelsPlan);

export async function planClineLemonadeModels(
	options: LemonadeModelsOptions & { modelsPath: string },
): Promise<ClineLemonadeModelsPlan> {
	const read = await readClineLemonadeEntry(options.modelsPath);
	if (read.kind !== "found") {
		return { kind: read.kind, details: [read.detail] };
	}
	return { kind: "found", ...(await planLemonadeModelsForEntry(read.entry, options)) };
}
