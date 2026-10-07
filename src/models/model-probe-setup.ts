// What a model probe needs from this machine: the Bedrock API key and region with its inference-profile list (cached
// in the Kanban home), and Lemonade's base URL. Shared by `kanban models probe` and the outage hold of recovery
// (src/pipeline/recovery-stage.ts), so both probe the same endpoint with the same key.
import { join } from "node:path";

import type { PipelineConfig } from "../config/pipeline-config";
import { getKanbanModelsDataPath } from "../state/kanban-home";
import { loadBedrockInferenceProfiles, resolveBedrockApiKey } from "./bedrock-probe";
import { getProviderSettingsPaths, readClineProvidersFile } from "./cline-providers";
import { LEMONADE_PROVIDER_ID, type ModelProbeDependencies } from "./model-probe";

const BEDROCK_PROFILES_CACHE_FILE = "bedrock-profiles.json";

export function getBedrockProfilesCachePath(): string {
	return join(getKanbanModelsDataPath(), BEDROCK_PROFILES_CACHE_FILE);
}

function readStringSetting(providersJson: unknown, providerId: string, key: string): string | null {
	const providers = (providersJson as { providers?: Record<string, { settings?: Record<string, unknown> }> } | null)
		?.providers;
	const value = providers?.[providerId]?.settings?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface LoadedModelProbeDependencies {
	deps: ModelProbeDependencies;
	region: string;
	hasBedrockKey: boolean;
	profilesSource: string;
	warning: string | null;
}

export async function loadModelProbeDependencies(
	config: PipelineConfig,
	options: { region?: string; needsBedrock?: boolean; refreshProfiles?: boolean } = {},
): Promise<LoadedModelProbeDependencies> {
	const providersJson = await readClineProvidersFile(getProviderSettingsPaths(config).providersPath);
	const region = options.region?.trim() || config.models.bedrockRegion;
	const apiKey = resolveBedrockApiKey(providersJson);
	const profiles =
		(options.needsBedrock ?? true) && apiKey
			? await loadBedrockInferenceProfiles(
					{ region, apiKey },
					{ cachePath: getBedrockProfilesCachePath(), refresh: options.refreshProfiles === true },
				)
			: { profiles: [], source: "none" as const, warning: null };
	const lemonadeBaseUrl =
		readStringSetting(providersJson, LEMONADE_PROVIDER_ID, "baseUrl") ??
		`${config.models.lists.lemonade.url.replace(/\/+$/u, "")}/api/v1`;
	return {
		deps: { bedrock: apiKey ? { region, apiKey, profiles: profiles.profiles } : null, lemonadeBaseUrl },
		region,
		hasBedrockKey: apiKey !== null,
		profilesSource: profiles.source,
		warning: profiles.warning,
	};
}
