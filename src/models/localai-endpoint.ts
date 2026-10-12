// Where Kanban asks LocalAI: `models.lists.localai.url` in config.json, else the baseUrl of Cline's `localai`
// custom provider (models.json, written by the user's `kanban cline apply-localai-provider`), so the URL the user gave
// that command is the one every Kanban reader uses (the model-lists route, the outage probe, doctor, `kanban models
// vet`). Null when neither says: LocalAI runs on whatever host the user put it on, so there is no default.
// Read-only, like every read of Cline's files.
import { readFile } from "node:fs/promises";

import { createLocalAiModelListSettingsLoader, type LocalAiModelListSettings } from "../config/model-lists-config";
import { type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import { getClineModelsSettingsPath } from "../state/kanban-home";
import { LOCALAI_PROVIDER_ID, localAiRootUrl } from "./localai-models";

function readObjectKey(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/** The `providers.localai.provider.baseUrl` of Cline's models.json, or null (no file, no entry, not JSON). */
export async function readClineLocalAiBaseUrl(modelsPath: string): Promise<string | null> {
	const raw = await readFile(modelsPath, "utf8").catch(() => null);
	if (raw === null) {
		return null;
	}
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		return null;
	}
	const provider = readObjectKey(readObjectKey(readObjectKey(document, "providers"), LOCALAI_PROVIDER_ID), "provider");
	const baseUrl = readObjectKey(provider, "baseUrl");
	return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;
}

/** LocalAI's root URL (without /v1): the configured one, else Cline's provider's; null when neither is set. */
export async function resolveLocalAiUrl(input: {
	configUrl: string | null;
	modelsPath: string;
}): Promise<string | null> {
	const url = input.configUrl?.trim() || (await readClineLocalAiBaseUrl(input.modelsPath));
	return url ? localAiRootUrl(url) : null;
}

/** resolveLocalAiUrl() for a parsed config.json. */
export async function resolveConfiguredLocalAiUrl(
	config: Pick<PipelineConfig, "models" | "agents">,
): Promise<string | null> {
	return await resolveLocalAiUrl({
		configUrl: config.models.lists.localai.url,
		modelsPath: getClineModelsSettingsPath(config.agents.cline.dataDir),
	});
}

/**
 * The model-lists route's LocalAI settings, read on every request: `models.lists.localai` (each distinct warning
 * logged once) with the URL resolved through Cline's provider when config.json sets none.
 */
export function createLocalAiModelListLoader(
	warn: (message: string) => void,
	configPath?: string,
): () => Promise<LocalAiModelListSettings> {
	const loadSettings = createLocalAiModelListSettingsLoader(warn, configPath);
	return async () => {
		const settings = await loadSettings();
		const { config } = await readPipelineConfig(configPath);
		return {
			...settings,
			url: await resolveLocalAiUrl({
				configUrl: settings.url,
				modelsPath: getClineModelsSettingsPath(config.agents.cline.dataDir),
			}),
		};
	};
}
