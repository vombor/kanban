// What LocalAI (an OpenAI-compatible model server, usually on another host: the user's runs in a container on the
// tailnet) says about its models, read for Cline cards: the list behind the model-lists route, each model's
// capabilities and context size for `kanban cline apply-localai-provider`, how many models it keeps loaded for
// `models.providerCapacity.localai`, and whether it is up for recovery's outage probe.
//
// Verified against LocalAI v4.11.0 (2026-10-11):
//   - GET /v1/models lists `{ id, object }` only, embedding and TTS models included; no key needed.
//   - GET /v1/models/capabilities lists each model with `capabilities` ("chat", "vision", "thinking", "embeddings",
//     ...), its input/output modalities and `context_size`: the model config's `context_size` (what llama.cpp is
//     started with), not a value read back from the loaded backend. Older LocalAIs have no such route (404).
//   - GET /system lists `loaded_models` (`{ id, backend, process }`): the models resident right now.
//   - GET /api/settings has `max_active_backends` (0 = unlimited) and `single_backend` (the old flag for one): how
//     many models LocalAI keeps loaded; it evicts the least recently used one for the next. An instance with API
//     keys answers 401 there, which reads as "unknown".
//   - GET /readyz answers 200 once the server is up (the outage probe).
// The OpenAI API is under `<url>/v1`; the other routes are on the root URL.
import { z } from "zod";

export const LOCALAI_PROVIDER_ID = "localai";

/** `fetch`, or a test's fake. */
export type LocalAiFetch = (input: string, init?: RequestInit) => Promise<Response>;

const UPSTREAM_TIMEOUT_MS = 4_000;
const HEALTH_TIMEOUT_MS = 30_000;

const modelsResponseSchema = z.object({ data: z.array(z.unknown()).default([]) });
const localAiModelSchema = z.looseObject({
	id: z.string().min(1),
	owned_by: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	context_size: z.number().optional(),
});
const localAiSettingsSchema = z.looseObject({
	max_active_backends: z.number().optional(),
	single_backend: z.boolean().optional(),
});
const localAiSystemSchema = z.looseObject({
	loaded_models: z.array(z.looseObject({ id: z.string().optional() })).optional(),
});

export interface LocalAiModel {
	id: string;
	ownedBy: string;
	/** Null when LocalAI didn't say (an older LocalAI without /v1/models/capabilities). */
	capabilities: string[] | null;
	/** The model config's `context_size`; null when unset or unknown. */
	contextSize: number | null;
}

function positiveOrNull(value: number | undefined): number | null {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : null;
}

/** /v1/models or /v1/models/capabilities as models. Entries that aren't models are skipped. */
export function parseLocalAiModels(payload: unknown): LocalAiModel[] {
	const models: LocalAiModel[] = [];
	for (const entry of modelsResponseSchema.parse(payload).data) {
		const parsed = localAiModelSchema.safeParse(entry);
		if (!parsed.success) {
			continue;
		}
		models.push({
			id: parsed.data.id,
			ownedBy: parsed.data.owned_by ?? LOCALAI_PROVIDER_ID,
			capabilities: parsed.data.capabilities ?? null,
			contextSize: positiveOrNull(parsed.data.context_size),
		});
	}
	return models;
}

/**
 * A model Cline should offer: one with every required capability (by default "chat", which leaves out embedding,
 * TTS and image models). A model whose capabilities LocalAI didn't report is offered: nothing tells it apart.
 */
export function isListedLocalAiModel(model: LocalAiModel, requireCapabilities: readonly string[]): boolean {
	return model.capabilities === null || requireCapabilities.every((name) => model.capabilities?.includes(name));
}

/** LocalAI's root URL without a trailing slash or `/v1` (the OpenAI API root). */
export function localAiRootUrl(url: string): string {
	return url.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

/** LocalAI's OpenAI API root (`<root>/v1`), where Cline sends its requests. */
export function localAiApiBaseUrl(url: string): string {
	return `${localAiRootUrl(url)}/v1`;
}

class LocalAiHttpError extends Error {
	constructor(readonly status: number) {
		super(`localai HTTP ${status}`);
	}
}

async function fetchJson(url: string, fetchImpl: LocalAiFetch, timeoutMs: number): Promise<unknown> {
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) {
		throw new LocalAiHttpError(response.status);
	}
	return await response.json();
}

/**
 * The models with their capabilities (/v1/models/capabilities), else the plain list (/v1/models) when this LocalAI
 * has no capabilities route. Throws when LocalAI is down or answers with an error.
 */
export async function fetchLocalAiModels(
	url: string,
	fetchImpl: LocalAiFetch = fetch,
	timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<LocalAiModel[]> {
	const api = localAiApiBaseUrl(url);
	try {
		return parseLocalAiModels(await fetchJson(`${api}/models/capabilities`, fetchImpl, timeoutMs));
	} catch (error) {
		if (!(error instanceof LocalAiHttpError && error.status === 404)) {
			throw error;
		}
	}
	return parseLocalAiModels(await fetchJson(`${api}/models`, fetchImpl, timeoutMs));
}

/**
 * How many models LocalAI keeps loaded (/api/settings: `max_active_backends`, or 1 for `single_backend`; -1 =
 * unlimited, as Lemonade's `max_models.llm` says it). Null when it can't be told (no such fields, or a LocalAI with
 * API keys, which answers 401). Throws when LocalAI is down.
 */
export async function fetchLocalAiMaxLoadedModels(
	url: string,
	fetchImpl: LocalAiFetch = fetch,
	timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<number | null> {
	let payload: unknown;
	try {
		payload = await fetchJson(`${localAiRootUrl(url)}/api/settings`, fetchImpl, timeoutMs);
	} catch (error) {
		if (error instanceof LocalAiHttpError) {
			return null;
		}
		throw error;
	}
	const settings = localAiSettingsSchema.safeParse(payload);
	if (!settings.success) {
		return null;
	}
	const max = settings.data.max_active_backends;
	if (max !== undefined && Number.isInteger(max) && max > 0) {
		return max;
	}
	if (settings.data.single_backend === true) {
		return 1;
	}
	return max === 0 ? -1 : null;
}

/**
 * Whether LocalAI has `modelId` loaded right now (/system `loaded_models`). LocalAI loads a model on its first
 * request, so one it doesn't list while a request for it is open is still loading. Null when it can't be asked.
 */
export async function fetchLocalAiModelLoaded(
	url: string,
	modelId: string,
	fetchImpl: LocalAiFetch = fetch,
	timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<boolean | null> {
	const payload = await fetchJson(`${localAiRootUrl(url)}/system`, fetchImpl, timeoutMs).catch(() => null);
	const system = localAiSystemSchema.safeParse(payload);
	if (!payload || !system.success) {
		return null;
	}
	return (system.data.loaded_models ?? []).some((model) => model.id === modelId);
}

export interface LocalAiHealth {
	up: boolean;
	url: string;
	status: number | null;
	detail: string;
}

/** GET <root>/readyz: up on a 2xx. Never throws; an unreachable host is `up: false` with the error as detail. */
export async function probeLocalAiHealth(url: string, fetchImpl: LocalAiFetch = fetch): Promise<LocalAiHealth> {
	const readyUrl = `${localAiRootUrl(url)}/readyz`;
	try {
		const response = await fetchImpl(readyUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		await response.body?.cancel().catch(() => {});
		return {
			up: response.ok,
			url: readyUrl,
			status: response.status,
			detail: response.ok ? "ready" : `HTTP ${response.status}`,
		};
	} catch (error) {
		const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
		return {
			up: false,
			url: readyUrl,
			status: null,
			detail: `${error instanceof Error ? error.message : String(error)}${cause}`,
		};
	}
}
