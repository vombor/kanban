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
// The wanted record has every model Lemonade lists (downloaded, with the route's required labels) with its
// contextWindow (see src/models/lemonade-models.ts for where the size comes from), maxTokens, supportsVision and
// supportsReasoning, and zero prices when none are set; other keys of a model are kept, and models Lemonade no longer
// lists are dropped. With Lemonade down no value changes (only a list is still rewritten as a record).
// Read-only: `kanban setup` and doctor print the differences, and only the user's `kanban cline
// apply-lemonade-models` (cline-lemonade-apply.ts) writes them (Kanban writes nothing under ~/.cline otherwise).
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

/** The wanted record: `current` with Lemonade's metadata for every listed model; with no catalog, `current`. */
export function buildDesiredLemonadeModels(
	current: StoredModels,
	catalog: LemonadeCatalog | null,
	requireLabels: readonly string[],
): { models: StoredModels; updates: LemonadeModelUpdate[] } {
	if (!catalog) {
		return { models: { ...current }, updates: [] };
	}
	const models: StoredModels = {};
	const updates: LemonadeModelUpdate[] = [];
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
		updates.push({ id: model.id, contextWindow, vision, reasoning });
	}
	return { models, updates };
}

export interface LemonadeFieldChange {
	key: string;
	from: unknown;
	to: unknown;
}

export interface LemonadeModelsDiff {
	/** The file has the list form cline 3.x rejects. */
	listForm: boolean;
	added: string[];
	removed: string[];
	changed: Array<{ id: string; fields: LemonadeFieldChange[] }>;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function diffLemonadeModels(stored: StoredModelsRead, desired: StoredModels): LemonadeModelsDiff {
	const added = Object.keys(desired).filter((id) => !(id in stored.models));
	const removed = Object.keys(stored.models).filter((id) => !(id in desired));
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
	return { listForm: stored.form === "list", added, removed, changed };
}

export function isLemonadeModelsDiffEmpty(diff: LemonadeModelsDiff): boolean {
	return !diff.listForm && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

function formatValue(value: unknown): string {
	return value === undefined ? "(unset)" : JSON.stringify(value);
}

function describeAdded(
	update: LemonadeModelUpdate | undefined,
	id: string,
	entry: StoredModelEntry | undefined,
): string {
	const features = [update?.vision ? "vision" : null, update?.reasoning ? "reasoning" : null].filter(Boolean);
	const context = update?.contextWindow
		? `context ${update.contextWindow.tokens} (${CONTEXT_SOURCE_LABELS[update.contextWindow.source]}), maxTokens ${entry?.maxTokens}`
		: `no context info from Lemonade; Cline's ${CLINE_DEFAULT_CONTEXT_WINDOW} default`;
	return `${id}: add, ${context}${features.length > 0 ? `, ${features.join(", ")}` : ""}`;
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

/** One line per difference, in the order added, changed, removed. */
export function describeLemonadeModelsDiff(
	diff: LemonadeModelsDiff,
	desired: StoredModels,
	updates: readonly LemonadeModelUpdate[],
): string[] {
	const updateById = new Map(updates.map((update) => [update.id, update]));
	return [
		...(diff.listForm
			? ["models is a list, which cline 3.x rejects (it drops the provider): rewrite as a record by id"]
			: []),
		...diff.added.map((id) => describeAdded(updateById.get(id), id, desired[id])),
		...diff.changed.map(({ id, fields }) => describeChange(id, fields, updateById.get(id))),
		...diff.removed.map((id) => `${id}: remove (Lemonade no longer lists it)`),
	];
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

export interface LemonadeModelsPlan {
	/** Lemonade answered and its models are already in the file. */
	inSync: boolean;
	/** Lemonade didn't answer (the wanted record is then the file's own, as a record). */
	unreachable: string | null;
	diff: LemonadeModelsDiff;
	/** The wanted `providers.lemonade.models`. */
	models: StoredModels;
	/** What is in sync, what would change, or why nothing can be compared. */
	details: string[];
}

export interface LemonadeModelsOptions {
	/** The model-lists route's labels (`models.lists.lemonade.requireLabels`), so both offer the same models. */
	requireLabels: readonly string[];
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
	const { models, updates } = buildDesiredLemonadeModels(stored.models, catalog, options.requireLabels);
	const diff = diffLemonadeModels(stored, models);
	const empty = isLemonadeModelsDiffEmpty(diff);
	const details = [
		...(unreachable ? [unreachable] : []),
		...describeLemonadeModelsDiff(diff, models, updates),
		...(catalog && updates.length === 0
			? [`Lemonade lists no downloaded model with labels ${options.requireLabels.join(", ") || "(none)"}`]
			: []),
		...(catalog && empty ? [describeInSync(models)] : []),
	];
	return { inSync: catalog !== null && empty, unreachable, diff, models, details };
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
