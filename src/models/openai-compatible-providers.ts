// The OpenAI-compatible model servers of config.json (`providers.openaiCompatible.<id>`,
// src/config/openai-compatible-providers-config.ts) and what Kanban asks them. One generic reader for every such
// server; nothing here is about one server.
//
// What Kanban reads is `GET <baseUrl>/models` only (the OpenAI list: `data[].id`), plus fields some servers add to it:
//   - `loaded` (boolean): whether the model is in memory now. A router that loads models on demand (the user's
//     Triton/TensorRT-LLM router, 2026-10-12) reports it, and a model that isn't loaded yet is loading, not silent
//     (the vet probe's isModelLoaded);
//   - a context window: `max_model_len` (vLLM), `context_length` or `context_window`. Triton's router sends none, so
//     its windows come from the config's `models.<id>.contextWindow`, else the conservative default
//     (OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW).
// The list also serves as the outage probe: a server that answers it with 200 is up.
//
// The configured providers are set by readPipelineConfig (every process reads config.json there first), so the
// provider-id rules that take no config (isLocalProvider, canProbeProvider, the TUI sign-in rule) know them.
import type {
	OpenAiCompatibleModelOverride,
	OpenAiCompatibleProviderSettings,
} from "../config/openai-compatible-providers-config";
import type { FetchLike } from "./bedrock-probe";

/**
 * The window Kanban writes for a model whose server reports none and whose config gives none: small enough for the
 * servers Kanban has seen (Triton's router doesn't say what TensorRT-LLM's engine allows), large enough for Cline's
 * system prompt and a few tool rounds. Cline compacts at its window; a window above the server's makes the server
 * refuse long requests instead. Override per model with `providers.openaiCompatible.<id>.models.<model>.contextWindow`.
 */
export const OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW = 32_768;

const MODELS_TIMEOUT_MS = 10_000;
const CONTEXT_WINDOW_FIELDS = ["max_model_len", "context_length", "context_window"] as const;

let configured: ReadonlyMap<string, OpenAiCompatibleProviderSettings> = new Map();

/** Replaces the known providers with config.json's (readPipelineConfig; tests). */
export function setConfiguredOpenAiCompatibleProviders(
	providers: Readonly<Record<string, OpenAiCompatibleProviderSettings>>,
): void {
	configured = new Map(Object.entries(providers));
}

export function getConfiguredOpenAiCompatibleProvider(
	providerId: string | null | undefined,
): OpenAiCompatibleProviderSettings | null {
	return providerId ? (configured.get(providerId) ?? null) : null;
}

export function listConfiguredOpenAiCompatibleProviders(): Array<[string, OpenAiCompatibleProviderSettings]> {
	return [...configured.entries()];
}

/** A configured provider with `local: true` (the user's own hardware). */
export function isConfiguredLocalProvider(providerId: string | null | undefined): boolean {
	return getConfiguredOpenAiCompatibleProvider(providerId)?.local === true;
}

/** The env variables configured providers take their keys from: secrets, kept out of the pipeline checks. */
export function listConfiguredProviderKeyEnvNames(): string[] {
	return [...configured.values()].flatMap((provider) => (provider.apiKeyEnv ? [provider.apiKeyEnv] : []));
}

/** The provider's key from the environment, when it has one configured and the env holds it. */
export function resolveProviderApiKey(
	provider: OpenAiCompatibleProviderSettings,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const value = provider.apiKeyEnv ? env[provider.apiKeyEnv]?.trim() : "";
	return value ? value : null;
}

export function buildOpenAiCompatibleModelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/models`;
}

export interface OpenAiCompatibleModel {
	id: string;
	/** The server's `loaded` flag; null when it sends none. */
	loaded: boolean | null;
	/** The server's context window for the model and the field it came from; null when it sends none. */
	contextWindow: { tokens: number; field: (typeof CONTEXT_WINDOW_FIELDS)[number] } | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseOpenAiCompatibleModels(body: unknown): OpenAiCompatibleModel[] {
	if (!isObject(body) || !Array.isArray(body.data)) {
		throw new Error("not an OpenAI model list (no data array)");
	}
	return body.data.flatMap((entry): OpenAiCompatibleModel[] => {
		if (!isObject(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
			return [];
		}
		const field = CONTEXT_WINDOW_FIELDS.find((name) => {
			const value = entry[name];
			return typeof value === "number" && Number.isInteger(value) && value > 0;
		});
		return [
			{
				id: entry.id,
				loaded: typeof entry.loaded === "boolean" ? entry.loaded : null,
				contextWindow: field ? { tokens: entry[field] as number, field } : null,
			},
		];
	});
}

export interface OpenAiCompatibleRequestOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

/** `GET <baseUrl>/models`; throws when the server doesn't answer with a model list. */
export async function fetchOpenAiCompatibleModels(
	provider: OpenAiCompatibleProviderSettings,
	options: OpenAiCompatibleRequestOptions = {},
): Promise<OpenAiCompatibleModel[]> {
	const apiKey = resolveProviderApiKey(provider, options.env);
	const response = await (options.fetch ?? fetch)(buildOpenAiCompatibleModelsUrl(provider.baseUrl), {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(options.timeoutMs ?? MODELS_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return parseOpenAiCompatibleModels(await response.json());
}

/** Whether the server has the model in memory now; null when it can't tell (no `loaded` flag, not listed, down). */
export async function fetchOpenAiCompatibleModelLoaded(
	provider: OpenAiCompatibleProviderSettings,
	model: string,
	options: OpenAiCompatibleRequestOptions = {},
): Promise<boolean | null> {
	try {
		return (await fetchOpenAiCompatibleModels(provider, options)).find((entry) => entry.id === model)?.loaded ?? null;
	} catch {
		return null;
	}
}

/** The outage probe: up when the server answers its model list. */
export async function probeOpenAiCompatibleHealth(
	provider: OpenAiCompatibleProviderSettings,
	options: OpenAiCompatibleRequestOptions = {},
): Promise<{ up: boolean; url: string; status: number | null; detail: string }> {
	const url = buildOpenAiCompatibleModelsUrl(provider.baseUrl);
	try {
		const models = await fetchOpenAiCompatibleModels(provider, { timeoutMs: 30_000, ...options });
		return { up: true, url, status: 200, detail: `lists ${models.length} model(s)` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = /^HTTP (\d+)$/u.exec(message);
		return { up: false, url, status: status ? Number(status[1]) : null, detail: message };
	}
}

/** The config's own window for a model, if it sets one. */
export function getModelOverride(
	provider: OpenAiCompatibleProviderSettings,
	model: string,
): OpenAiCompatibleModelOverride | null {
	return provider.models[model] ?? null;
}
