// Bedrock tool-call probe: does a model make a tool call through the Converse API, the API Cline's native
// "bedrock" provider uses. `kanban models probe` prints it; outage recovery (P4-6) calls `probeBedrockModel` to
// decide when a held card's model answers again.
//
// Ported from archive/devteam-kit:probes/bedrock-converse-probe.mjs@60abaff, with its rules:
//   - a model id gets its `us.*` inference profile when Bedrock has one (US profiles only), else it is used as given;
//   - the profile list is cached (`<home>/data/models/bedrock-profiles.json`; `--refresh` re-fetches it);
//   - xAI / Grok models are never probed (hard rule).
// The legacy callers (autoland's outage hold, wake-when --model-up) matched /\tTOOL / in the probe's text output,
// which prints " | "-separated lines, so a Bedrock probe never counted as up. Callers here get `toolCall`.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const BEDROCK_PROVIDER_ID = "bedrock";
export const BEDROCK_API_KEY_ENV = "BEDROCK_API_KEY";

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DETAIL_MAX_CHARS = 90;
const NEVER_PROBED_MODEL_PATTERN = /xai|grok/iu;
const US_PROFILE_PREFIX = "us.";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BedrockEndpoint {
	region: string;
	apiKey: string;
	fetch?: FetchLike;
}

export interface BedrockProbeResult {
	/** The id as asked for. */
	requestedModelId: string;
	/** The id sent to Bedrock (the `us.*` profile when there is one). */
	modelId: string;
	/** HTTP status, or null when the request failed before a response (network, timeout). */
	status: number | null;
	toolCall: boolean;
	/** `TOOL {input}` on a tool call, else Bedrock's message or stop reason, or the request error. */
	detail: string;
	elapsedMs: number;
}

/** xAI / Grok models are never used, so never probed. */
export function isNeverProbedModel(modelId: string): boolean {
	return NEVER_PROBED_MODEL_PATTERN.test(modelId);
}

/** The `us.*` inference profile of a model id when Bedrock lists one, else the id itself. */
export function resolveBedrockInferenceProfile(modelId: string, profiles: readonly string[]): string {
	const profile = `${US_PROFILE_PREFIX}${modelId}`;
	return profiles.includes(profile) ? profile : modelId;
}

function authHeaders(apiKey: string): Record<string, string> {
	return { authorization: `Bearer ${apiKey}` };
}

export interface InferenceProfileListing {
	profiles: string[];
	/** HTTP status of the listing request, or null on a request error. */
	status: number | null;
	error: string | null;
}

export async function fetchBedrockInferenceProfiles(endpoint: BedrockEndpoint): Promise<InferenceProfileListing> {
	const fetchImpl = endpoint.fetch ?? fetch;
	try {
		const response = await fetchImpl(
			`https://bedrock.${endpoint.region}.amazonaws.com/inference-profiles?maxResults=1000`,
			{ headers: authHeaders(endpoint.apiKey), signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) },
		);
		const body = (await response.json().catch(() => ({}))) as { inferenceProfileSummaries?: unknown };
		const summaries = Array.isArray(body.inferenceProfileSummaries) ? body.inferenceProfileSummaries : [];
		const profiles = summaries
			.map((summary) => (summary as { inferenceProfileId?: unknown }).inferenceProfileId)
			.filter((id): id is string => typeof id === "string");
		return { profiles, status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
	} catch (error) {
		return { profiles: [], status: null, error: error instanceof Error ? error.message : String(error) };
	}
}

interface ProfileCacheFile {
	fetchedAt: string;
	profiles: string[];
}

async function readProfileCache(cachePath: string): Promise<ProfileCacheFile | null> {
	try {
		const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<ProfileCacheFile>;
		return Array.isArray(parsed.profiles) && typeof parsed.fetchedAt === "string"
			? { fetchedAt: parsed.fetchedAt, profiles: parsed.profiles.filter((id) => typeof id === "string") }
			: null;
	} catch {
		return null;
	}
}

export interface LoadedInferenceProfiles {
	profiles: string[];
	source: "cache" | "bedrock" | "none";
	/** Set when the list could not be fetched; model ids are then used as given. */
	warning: string | null;
}

/** The cached profile list, else (or with `refresh`) a fresh one, written to the cache only when non-empty. */
export async function loadBedrockInferenceProfiles(
	endpoint: BedrockEndpoint,
	options: { cachePath: string; refresh: boolean; now?: Date },
): Promise<LoadedInferenceProfiles> {
	if (!options.refresh) {
		const cached = await readProfileCache(options.cachePath);
		if (cached) {
			return { profiles: cached.profiles, source: "cache", warning: null };
		}
	}
	const listing = await fetchBedrockInferenceProfiles(endpoint);
	if (listing.profiles.length === 0) {
		return {
			profiles: [],
			source: "none",
			warning: `could not list inference profiles (${listing.error ?? "empty list"}); using model ids as given`,
		};
	}
	const cache: ProfileCacheFile = {
		fetchedAt: (options.now ?? new Date()).toISOString(),
		profiles: listing.profiles,
	};
	await mkdir(dirname(options.cachePath), { recursive: true });
	const tempPath = `${options.cachePath}.tmp.${process.pid}`;
	await writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
	await rename(tempPath, options.cachePath);
	return { profiles: listing.profiles, source: "bedrock", warning: null };
}

const PROBE_REQUEST_BODY = {
	messages: [
		{ role: "user", content: [{ text: "Use the read_file tool to read package.json. Do not answer in text." }] },
	],
	toolConfig: {
		tools: [
			{
				toolSpec: {
					name: "read_file",
					description: "Read a file from the repo",
					inputSchema: {
						json: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				},
			},
		],
	},
	inferenceConfig: { maxTokens: 300 },
};

interface ConverseResponseBody {
	output?: { message?: { content?: Array<{ toolUse?: { input?: unknown } }> } };
	message?: unknown;
	stopReason?: unknown;
}

/**
 * One Converse request that asks for a tool call. `modelId` is sent as given; resolve the inference profile first
 * (`resolveBedrockInferenceProfile`). Never throws.
 */
export async function probeBedrockModel(
	endpoint: BedrockEndpoint,
	modelId: string,
	options: { requestedModelId?: string; timeoutMs?: number; now?: () => number } = {},
): Promise<BedrockProbeResult> {
	const now = options.now ?? Date.now;
	const startedAt = now();
	const base = { requestedModelId: options.requestedModelId ?? modelId, modelId };
	const fetchImpl = endpoint.fetch ?? fetch;
	try {
		const response = await fetchImpl(
			`https://bedrock-runtime.${endpoint.region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`,
			{
				method: "POST",
				headers: { ...authHeaders(endpoint.apiKey), "content-type": "application/json" },
				body: JSON.stringify(PROBE_REQUEST_BODY),
				signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
			},
		);
		const body = (await response.json().catch(() => ({}))) as ConverseResponseBody;
		const toolUse = body.output?.message?.content?.find((part) => part.toolUse)?.toolUse;
		const reason =
			typeof body.message === "string" && body.message
				? body.message
				: typeof body.stopReason === "string" && body.stopReason
					? body.stopReason
					: "no tool";
		return {
			...base,
			status: response.status,
			toolCall: Boolean(toolUse),
			detail: toolUse ? `TOOL ${JSON.stringify(toolUse.input ?? null)}` : reason.slice(0, DETAIL_MAX_CHARS),
			elapsedMs: now() - startedAt,
		};
	} catch (error) {
		return {
			...base,
			status: null,
			toolCall: false,
			detail: (error instanceof Error ? error.message : String(error)).slice(0, DETAIL_MAX_CHARS),
			elapsedMs: now() - startedAt,
		};
	}
}

/** Bedrock API key: BEDROCK_API_KEY, else the `bedrock` entry of Cline's providers.json. */
export function resolveBedrockApiKey(providersJson: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
	const fromEnv = env[BEDROCK_API_KEY_ENV]?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const providers = (providersJson as { providers?: Record<string, { settings?: { apiKey?: unknown } }> } | null)
		?.providers;
	const apiKey = providers?.[BEDROCK_PROVIDER_ID]?.settings?.apiKey;
	return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
}
