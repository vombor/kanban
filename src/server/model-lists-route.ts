// GET /api/model-lists/lemonade: a curated, live model list for Cline's dynamic `modelsSourceUrl`.
//
// Ported from archive/devteam-kit:services/model-lists.mjs@6a2ba0e (the kit's model-lists service on :13306).
// Cline fetches a provider's model ids from `modelsSourceUrl` (GET, 5 s timeout, cached) and offers every
// `data[].id`; it can't filter. Lemonade's /api/v1/models also lists image, speech and TTS models (Flux, Whisper,
// kokoro), and a coding card must never land on those (user, 2026-10-06). So this serves Lemonade's list
// filtered to downloaded models with every label in `models.lists.lemonade.requireLabels` (default
// "tool-calling"), in the same `{ object: "list", data: [...] }` shape. Upstream errors return 502 so Cline
// keeps its static fallback list (the `models` in its models.json).
//
// Only ids reach Cline from here: cline 3.0.69's source fetch keeps `data[].id` and nothing else
// (@cline/core `extractModelIdsFromPayload`). Context windows, vision and reasoning go into models.json instead
// (`kanban setup`, src/setup/cline-lemonade-models.ts).
import type { IncomingMessage, ServerResponse } from "node:http";

import type { LemonadeModelListSettings } from "../config/model-lists-config";
import {
	fetchLemonadeModels,
	isListedLemonadeModel,
	lemonadeApiBaseUrl,
	parseLemonadeModels,
} from "../models/lemonade-models";

export const LEMONADE_MODEL_LIST_PATH = "/api/model-lists/lemonade";

export interface ModelListEntry {
	id: string;
	object: "model";
	owned_by: string;
	labels: string[];
}

export interface ModelListResponse {
	object: "list";
	data: ModelListEntry[];
}

/** Keeps downloaded models that carry every required label. Entries that aren't models are skipped. */
export function filterLemonadeModels(payload: unknown, requireLabels: readonly string[]): ModelListResponse {
	return toModelListResponse(parseLemonadeModels(payload), requireLabels);
}

function toModelListResponse(
	models: ReturnType<typeof parseLemonadeModels>,
	requireLabels: readonly string[],
): ModelListResponse {
	const data = models
		.filter((model) => isListedLemonadeModel(model, requireLabels))
		.map(
			(model): ModelListEntry => ({ id: model.id, object: "model", owned_by: model.ownedBy, labels: model.labels }),
		);
	return { object: "list", data };
}

export interface ModelListsRouteDependencies {
	loadLemonadeSettings: () => Promise<LemonadeModelListSettings>;
	fetch?: typeof fetch;
	warn: (message: string) => void;
}

export async function fetchLemonadeModelList(
	settings: LemonadeModelListSettings,
	fetchImpl: typeof fetch = fetch,
): Promise<ModelListResponse> {
	return toModelListResponse(
		await fetchLemonadeModels(lemonadeApiBaseUrl(settings.url), fetchImpl),
		settings.requireLabels,
	);
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		...headers,
	});
	res.end(JSON.stringify(body));
}

/**
 * Returns a handler that answers model-list requests and reports whether it did. `pathname` is the normalized
 * request path; anything else is left to the caller.
 */
export function createModelListsRequestHandler(
	deps: ModelListsRouteDependencies,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
	let lastError: string | null = null;
	return async (req, res, pathname) => {
		if (pathname.replace(/\/+$/u, "") !== LEMONADE_MODEL_LIST_PATH) {
			return false;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			writeJson(res, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
			return true;
		}
		try {
			const body = await fetchLemonadeModelList(await deps.loadLemonadeSettings(), deps.fetch);
			lastError = null;
			writeJson(res, 200, body);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Cline re-fetches after its cache expires; log a failing Lemonade once, not on every fetch.
			if (message !== lastError) {
				deps.warn(`[model-lists] lemonade list failed: ${message}`);
			}
			lastError = message;
			writeJson(res, 502, { error: message });
		}
		return true;
	};
}
