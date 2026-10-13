import { getRuntimeAgentCatalogEntry, RUNTIME_AGENT_CATALOG } from "./agent-catalog";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "./api-contract";

// Normalized copy of a task's agent settings: trims provider/model IDs, drops
// empty fields, and never retains a caller-owned object reference.
export function cloneRuntimeTaskAgentSettings(
	settings?: RuntimeTaskAgentSettings | null,
): RuntimeTaskAgentSettings | undefined {
	if (settings === undefined || settings === null) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

/**
 * Kanban's default model per agent CLI (config.json `agentDefaults`, the settings dialog): `{ providerId?, modelId?,
 * reasoningEffort? }` per agent id, passed verbatim like a card's own settings.
 */
export type RuntimeAgentDefaultSettings = Partial<Record<RuntimeAgentId, RuntimeTaskAgentSettings>>;

/** One agent's default with the fields its CLI can't take at launch (capability `none`) dropped; undefined if empty. */
export function getAgentDefaultSettings(
	agentId: RuntimeAgentId,
	agentDefaults: RuntimeAgentDefaultSettings | null | undefined,
): RuntimeTaskAgentSettings | undefined {
	const capabilities = getRuntimeAgentCatalogEntry(agentId)?.capabilities;
	const settings = cloneRuntimeTaskAgentSettings(agentDefaults?.[agentId]);
	if (!capabilities || !settings) {
		return undefined;
	}
	const supported: RuntimeTaskAgentSettings = {
		...(settings.providerId && capabilities.providerOverride !== "none" ? { providerId: settings.providerId } : {}),
		...(settings.modelId && capabilities.modelOverride !== "none" ? { modelId: settings.modelId } : {}),
		...(settings.reasoningEffort && capabilities.effortOverride !== "none"
			? { reasoningEffort: settings.reasoningEffort }
			: {}),
	};
	return Object.keys(supported).length > 0 ? supported : undefined;
}

/**
 * Every agent's default from untrusted input (config.json, a settings save), in catalog order so two equal values
 * serialize the same. Unknown agent ids and empty entries are dropped; the old id "cline-cli" reads as "cline".
 */
export function normalizeRuntimeAgentDefaultSettings(value: unknown): RuntimeAgentDefaultSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const raw = value as Record<string, unknown>;
	const normalized: RuntimeAgentDefaultSettings = {};
	for (const { id } of RUNTIME_AGENT_CATALOG) {
		const entry = raw[id] ?? (id === "cline" ? raw["cline-cli"] : undefined);
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const { providerId, modelId, reasoningEffort } = entry as Record<string, unknown>;
		const settings = getAgentDefaultSettings(id, {
			[id]: {
				...(typeof providerId === "string" ? { providerId } : {}),
				...(typeof modelId === "string" ? { modelId } : {}),
				...(typeof reasoningEffort === "string" ? { reasoningEffort: reasoningEffort.trim() } : {}),
			},
		});
		if (settings) {
			normalized[id] = settings;
		}
	}
	return normalized;
}

/**
 * The agent settings a launch passes to the agent's CLI (runtimeApi.startTaskSession, the headless orchestrator run).
 * Precedence: the card's own model (which is also where a routing kit's role model is, written onto the card when
 * the kit assigned it) > Kanban's per-agent default > the CLI's own config (nothing passed). The default is one unit:
 * a card that names a model keeps its own provider and effort as they are (the default's effort was chosen for the
 * default's model); a card without a model gets the default's model, and its provider and effort unless the card sets
 * those itself. The orchestrator's sidebar and its headless wakes name no model, so they run on the default.
 */
export function resolveLaunchAgentSettings(
	agentId: RuntimeAgentId,
	cardSettings: RuntimeTaskAgentSettings | null | undefined,
	agentDefaults: RuntimeAgentDefaultSettings | null | undefined,
): RuntimeTaskAgentSettings | undefined {
	const card = cloneRuntimeTaskAgentSettings(cardSettings);
	const fallback = getAgentDefaultSettings(agentId, agentDefaults);
	if (card?.modelId || !fallback) {
		return card;
	}
	return { ...fallback, ...card };
}
