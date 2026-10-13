import type { RuntimeTaskAgentSettings } from "@/runtime/types";

export interface BoardCardAgentModel {
	/** The model text after the agent name on the pill; null shows the name alone. */
	label: string | null;
	/** An extra tooltip line naming every model the sessions used, when there were several and the card names none. */
	usedModelsDetail: string | null;
}

/**
 * The agent pill's model. A model set on the card wins (agent settings are opaque per-agent strings, e.g. Cline
 * --provider/--model/--thinking, shown verbatim); a card that names none shows the model its agent sessions last used
 * (`usedModels`, most recent first, read from the agents' own session files), so a Claude Code or Codex card shows its
 * model as a Cline card does. With no used model either, the card's settings say what they can ("Default model").
 */
export function describeBoardCardAgentModel(
	agentSettings: RuntimeTaskAgentSettings | undefined,
	usedModels: readonly string[],
): BoardCardAgentModel {
	const { providerId, modelId, reasoningEffort } = agentSettings ?? {};
	const latestUsedModel = usedModels[0];
	if (!modelId && latestUsedModel) {
		return {
			label: reasoningEffort ? `${latestUsedModel} (${reasoningEffort})` : latestUsedModel,
			usedModelsDetail: usedModels.length > 1 ? `Models used, latest first: ${usedModels.join(", ")}` : null,
		};
	}
	if (agentSettings === undefined) {
		return { label: null, usedModelsDetail: null };
	}
	const effortLabel = reasoningEffort ? reasoningEffort : !providerId && !modelId ? "Default" : null;
	if (providerId && !modelId) {
		const providerLabel = `Provider: ${providerId}`;
		return { label: effortLabel ? `${providerLabel} (${effortLabel})` : providerLabel, usedModelsDetail: null };
	}
	if (!modelId) {
		return { label: effortLabel ? `Default model (${effortLabel})` : null, usedModelsDetail: null };
	}
	return { label: effortLabel ? `${modelId} (${effortLabel})` : modelId, usedModelsDetail: null };
}
