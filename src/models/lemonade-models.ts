// What Lemonade (the local llama.cpp router on :13305) says about its models, read for Cline: the list behind the
// model-lists route, and each model's real context window for `kanban setup`'s models.json metadata.
//
// Context sizes, verified against lemonade-sdk/lemonade@v11.5.2 (the installed server):
//   - llama-server is started with `--ctx-size <recipe ctx_size>` (src/cpp/server/backends/llamacpp/llamacpp_server.cpp
//     `load`); the per-model recipe option wins over the global `ctx_size` in /api/v1/params.
//   - `ctx_size: -1` (the global default) auto-tunes at load time from free memory, clamped to the model's
//     `max_context_window` (src/cpp/include/lemon/auto_tune.h), so the max is an upper bound, not a promise.
//   - /api/v1/health lists loaded models with their effective `recipe_options.ctx_size` (after auto-tune).
// So the window is: the loaded value, else the recipe's, else the global one, else the model's max. A window larger
// than the one llama-server got makes llama.cpp reject the request instead of letting Cline compact first.
import { z } from "zod";

const UPSTREAM_TIMEOUT_MS = 4_000;

const lemonadeModelSchema = z.object({
	id: z.string(),
	owned_by: z.string().optional(),
	labels: z.array(z.string()).optional(),
	downloaded: z.boolean().optional(),
	max_context_window: z.number().optional(),
	recipe_options: z.looseObject({ ctx_size: z.number().optional() }).optional(),
});
const lemonadeModelsResponseSchema = z.object({ data: z.array(z.unknown()).default([]) });
const lemonadeParamsSchema = z.looseObject({ ctx_size: z.number().optional() });
const lemonadeHealthSchema = z.looseObject({
	all_models_loaded: z
		.array(
			z.looseObject({
				model_name: z.string().optional(),
				recipe_options: z.looseObject({ ctx_size: z.number().optional() }).optional(),
			}),
		)
		.optional(),
});

export interface LemonadeModel {
	id: string;
	ownedBy: string;
	labels: string[];
	downloaded: boolean;
	/** The model's trained maximum (GGUF metadata), when Lemonade knows it. */
	maxContextWindow: number | null;
	/** The per-model `ctx_size` recipe option; null when unset or -1 (auto). */
	recipeCtxSize: number | null;
}

function positiveOrNull(value: number | undefined): number | null {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : null;
}

/** Lemonade's /api/v1/models payload as models. Entries that aren't models are skipped. */
export function parseLemonadeModels(payload: unknown): LemonadeModel[] {
	const models: LemonadeModel[] = [];
	for (const entry of lemonadeModelsResponseSchema.parse(payload).data) {
		const parsed = lemonadeModelSchema.safeParse(entry);
		if (!parsed.success) {
			continue;
		}
		const model = parsed.data;
		models.push({
			id: model.id,
			ownedBy: model.owned_by ?? "lemonade",
			labels: model.labels ?? [],
			downloaded: model.downloaded !== false,
			maxContextWindow: positiveOrNull(model.max_context_window),
			recipeCtxSize: positiveOrNull(model.recipe_options?.ctx_size),
		});
	}
	return models;
}

/** A model Cline should offer: downloaded, with every required label (by default "tool-calling"). */
export function isListedLemonadeModel(model: LemonadeModel, requireLabels: readonly string[]): boolean {
	return model.downloaded && requireLabels.every((label) => model.labels.includes(label));
}

export type LemonadeContextSource = "loaded" | "recipe" | "global" | "model-max";

export interface LemonadeContextWindow {
	tokens: number;
	source: LemonadeContextSource;
}

export interface LemonadeCatalog {
	models: LemonadeModel[];
	/** The global `ctx_size` from /api/v1/params; null when -1 (auto) or unknown. */
	globalCtxSize: number | null;
	/** Effective `ctx_size` of the models loaded right now, by id. */
	loadedCtxSizes: ReadonlyMap<string, number>;
}

/** The context llama-server runs (or will run) the model with; null when Lemonade says nothing about it. */
export function resolveLemonadeContextWindow(
	model: LemonadeModel,
	catalog: Pick<LemonadeCatalog, "globalCtxSize" | "loadedCtxSizes">,
): LemonadeContextWindow | null {
	const loaded = catalog.loadedCtxSizes.get(model.id);
	if (loaded !== undefined) {
		return { tokens: loaded, source: "loaded" };
	}
	if (model.recipeCtxSize !== null) {
		return { tokens: model.recipeCtxSize, source: "recipe" };
	}
	if (catalog.globalCtxSize !== null) {
		return { tokens: catalog.globalCtxSize, source: "global" };
	}
	if (model.maxContextWindow !== null) {
		return { tokens: model.maxContextWindow, source: "model-max" };
	}
	return null;
}

/** Lemonade's OpenAI-style API root (`<url>/api/v1`) for a base URL like http://localhost:13305. */
export function lemonadeApiBaseUrl(url: string): string {
	return `${url.replace(/\/+$/u, "")}/api/v1`;
}

async function fetchJson(url: string, fetchImpl: typeof fetch, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<unknown> {
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) {
		throw new Error(`lemonade HTTP ${response.status}`);
	}
	return await response.json();
}

/** GET <apiBaseUrl>/models. Throws when Lemonade is down or answers with an error. */
export async function fetchLemonadeModels(
	apiBaseUrl: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<LemonadeModel[]> {
	return parseLemonadeModels(await fetchJson(`${apiBaseUrl.replace(/\/+$/u, "")}/models`, fetchImpl, timeoutMs));
}

/**
 * The model list plus what decides each model's context: the global ctx_size (/params) and the loaded models
 * (/health). Only the model list is required; an older Lemonade without the other two still resolves recipe and
 * model-max windows. The three requests run in parallel, each capped at `timeoutMs`.
 */
export async function fetchLemonadeCatalog(
	apiBaseUrl: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<LemonadeCatalog> {
	const base = apiBaseUrl.replace(/\/+$/u, "");
	const [models, params, health] = await Promise.all([
		fetchLemonadeModels(base, fetchImpl, timeoutMs),
		fetchJson(`${base}/params`, fetchImpl, timeoutMs).catch(() => null),
		fetchJson(`${base}/health`, fetchImpl, timeoutMs).catch(() => null),
	]);
	const parsedParams = lemonadeParamsSchema.safeParse(params);
	const parsedHealth = lemonadeHealthSchema.safeParse(health);
	const loadedCtxSizes = new Map<string, number>();
	for (const loaded of parsedHealth.success ? (parsedHealth.data.all_models_loaded ?? []) : []) {
		const ctxSize = positiveOrNull(loaded.recipe_options?.ctx_size);
		if (loaded.model_name && ctxSize !== null) {
			loadedCtxSizes.set(loaded.model_name, ctxSize);
		}
	}
	return {
		models,
		globalCtxSize: parsedParams.success ? positiveOrNull(parsedParams.data.ctx_size) : null,
		loadedCtxSizes,
	};
}
