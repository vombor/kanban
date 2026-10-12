// How many models a local provider keeps loaded, asked from the server itself, for the residency rows of `kanban
// doctor` and `kanban kit show` (src/kits/local-residency.ts): Lemonade's /api/v1/health `max_models.llm`, LocalAI's
// /api/settings `max_active_backends`. -1 = unlimited; null = the server doesn't say.
import type { PipelineConfig } from "../config/pipeline-config";
import { fetchLemonadeMaxLoadedLlms, lemonadeApiBaseUrl } from "./lemonade-models";
import { resolveConfiguredLocalAiUrl } from "./localai-endpoint";
import { fetchLocalAiMaxLoadedModels, LOCALAI_PROVIDER_ID, localAiRootUrl } from "./localai-models";
import { LEMONADE_PROVIDER_ID } from "./model-probe";

/** The local providers whose residency Kanban can ask, in the order rows are printed. */
export const RESIDENCY_PROVIDER_IDS = [LEMONADE_PROVIDER_ID, LOCALAI_PROVIDER_ID] as const;

export type LocalProviderLimit =
	| { kind: "known"; endpoint: string; maxLoaded: number }
	/** The server answered without the field (an older one, or LocalAI with API keys). */
	| { kind: "unknown"; endpoint: string }
	/** The server didn't answer. */
	| { kind: "unreachable"; endpoint: string; error: string }
	/** Kanban doesn't know where the server is (LocalAI without a URL). */
	| { kind: "unconfigured"; detail: string };

export async function fetchLocalProviderLimit(
	provider: string,
	config: Pick<PipelineConfig, "models" | "agents">,
	options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<LocalProviderLimit> {
	let endpoint: string;
	let ask: () => Promise<number | null>;
	if (provider === LEMONADE_PROVIDER_ID) {
		const api = lemonadeApiBaseUrl(config.models.lists.lemonade.url);
		endpoint = `${api}/health`;
		ask = async () => await fetchLemonadeMaxLoadedLlms(api, options.fetch, options.timeoutMs);
	} else if (provider === LOCALAI_PROVIDER_ID) {
		const url = await resolveConfiguredLocalAiUrl(config);
		if (!url) {
			return {
				kind: "unconfigured",
				detail: "LocalAI's URL is unknown (models.lists.localai.url, or Cline's localai provider)",
			};
		}
		endpoint = `${localAiRootUrl(url)}/api/settings`;
		ask = async () => await fetchLocalAiMaxLoadedModels(url, options.fetch, options.timeoutMs);
	} else {
		return { kind: "unconfigured", detail: `${provider} is not a local provider Kanban can ask` };
	}
	try {
		const maxLoaded = await ask();
		return maxLoaded === null ? { kind: "unknown", endpoint } : { kind: "known", endpoint, maxLoaded };
	} catch (error) {
		return { kind: "unreachable", endpoint, error: error instanceof Error ? error.message : String(error) };
	}
}
