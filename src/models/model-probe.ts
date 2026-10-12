// "Does this card's model answer?" for outage recovery (P4-6) and `kanban models probe --provider`.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@f9ed1c3 (probeArgs, probeHealthUrl):
//   - bedrock: a real tool-call request through Converse (bedrock-probe.ts);
//   - lemonade (the local llama.cpp server) has no tool-call probe: its /health says status "ok" once the server
//     is up. Without it a lemonade card on outage hold only ended at the 6 h give-up (3b84abe);
//   - localai (on another host, src/models/localai-models.ts): its /readyz answers 200 once the server is up, and an
//     unreachable host (refused, reset, DNS) is down, so its cards get the same outage hold;
//   - any other provider: no probe, so the caller can't hold the card for an outage (it escalates instead).
// The deprecated openai-native probe (`--openai`, Bedrock /openai/v1) is not ported.
import {
	BEDROCK_PROVIDER_ID,
	type BedrockEndpoint,
	type BedrockProbeResult,
	type FetchLike,
	isNeverProbedModel,
	probeBedrockModel,
	resolveBedrockInferenceProfile,
} from "./bedrock-probe";
import { LOCALAI_PROVIDER_ID, probeLocalAiHealth } from "./localai-models";

export const LEMONADE_PROVIDER_ID = "lemonade";

const HEALTH_TIMEOUT_MS = 30_000;

export interface ProbeTarget {
	provider: string | null;
	model: string;
}

export type ModelProbeOutcome =
	| { kind: "tool-call"; up: boolean; result: BedrockProbeResult }
	| { kind: "health"; up: boolean; url: string; status: number | null; detail: string }
	| { kind: "unsupported"; up: false; reason: string };

export interface ModelProbeDependencies {
	/** Null when no Bedrock API key is configured. */
	bedrock: (BedrockEndpoint & { profiles: readonly string[] }) | null;
	/** Lemonade's OpenAI-compatible base URL (`…/api/v1`). */
	lemonadeBaseUrl: string;
	/** LocalAI's root URL (src/models/localai-endpoint.ts); null when no LocalAI is set up. */
	localAiUrl?: string | null;
	fetch?: FetchLike;
}

export function buildLemonadeHealthUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/health`;
}

/** True when the card's provider has a probe, so an outage on it can be held and probed. */
export function canProbeProvider(provider: string | null): boolean {
	return provider === BEDROCK_PROVIDER_ID || provider === LEMONADE_PROVIDER_ID || provider === LOCALAI_PROVIDER_ID;
}

export async function probeLemonadeHealth(
	baseUrl: string,
	fetchImpl: FetchLike = fetch,
): Promise<Extract<ModelProbeOutcome, { kind: "health" }>> {
	const url = buildLemonadeHealthUrl(baseUrl);
	try {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
		const status = typeof body?.status === "string" ? body.status : null;
		return {
			kind: "health",
			up: status === "ok",
			url,
			status: response.status,
			detail: status ? `status ${status}` : `HTTP ${response.status}, no status`,
		};
	} catch (error) {
		return {
			kind: "health",
			up: false,
			url,
			status: null,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function probeModel(target: ProbeTarget, deps: ModelProbeDependencies): Promise<ModelProbeOutcome> {
	if (target.provider === LEMONADE_PROVIDER_ID) {
		return await probeLemonadeHealth(deps.lemonadeBaseUrl, deps.fetch);
	}
	if (target.provider === LOCALAI_PROVIDER_ID) {
		if (!deps.localAiUrl) {
			return {
				kind: "health",
				up: false,
				url: "(none)",
				status: null,
				detail: "LocalAI's URL is unknown (models.lists.localai.url, or Cline's localai provider)",
			};
		}
		return { kind: "health", ...(await probeLocalAiHealth(deps.localAiUrl, deps.fetch)) };
	}
	if (target.provider !== BEDROCK_PROVIDER_ID) {
		return { kind: "unsupported", up: false, reason: `no probe for provider ${target.provider ?? "(none)"}` };
	}
	if (isNeverProbedModel(target.model)) {
		return { kind: "unsupported", up: false, reason: `${target.model}: xAI models are never used` };
	}
	if (!deps.bedrock) {
		return {
			kind: "unsupported",
			up: false,
			reason: "no Bedrock API key (BEDROCK_API_KEY or Cline's bedrock provider)",
		};
	}
	const modelId = resolveBedrockInferenceProfile(target.model, deps.bedrock.profiles);
	const result = await probeBedrockModel({ ...deps.bedrock, fetch: deps.fetch ?? deps.bedrock.fetch }, modelId, {
		requestedModelId: target.model,
	});
	return { kind: "tool-call", up: result.toolCall, result };
}
