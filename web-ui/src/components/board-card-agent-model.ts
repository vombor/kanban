import { type RuntimeAgentDefaultSettings, resolveLaunchAgentSettings } from "@runtime-task-agent-settings";

import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "@/runtime/types";

export interface BoardCardAgentModel {
	/** The model text after the agent name on the pill; null shows the name alone. */
	label: string | null;
	/**
	 * An extra tooltip line: every model the sessions used, when there were several and the card names none, or that
	 * the model is Kanban's default for the agent.
	 */
	detail: string | null;
}

export interface BoardCardAgentDefault {
	/** The card's effective agent; null before the config says which agent a card without one runs on. */
	agentId: RuntimeAgentId | null;
	/** Kanban's default model per agent (settings), what a launch passes when the card names no model. */
	agentDefaults: RuntimeAgentDefaultSettings;
}

function withEffort(model: string, reasoningEffort: string | undefined): string {
	return reasoningEffort ? `${model} (${reasoningEffort})` : model;
}

/**
 * The agent pill's model. A model set on the card wins (agent settings are opaque per-agent strings, e.g. Cline
 * --provider/--model/--thinking, shown verbatim); a card that names none shows the model its agent sessions last used
 * (`usedModels`, most recent first, read from the agents' own session files), so a Claude Code or Codex card shows its
 * model as a Cline card does. Before any session, a card naming no model shows the agent's default from Kanban
 * settings, the model its launch will pass (resolveLaunchAgentSettings); with none, the card's settings say what they
 * can ("Default model": the CLI's own).
 */
export function describeBoardCardAgentModel(
	agentSettings: RuntimeTaskAgentSettings | undefined,
	usedModels: readonly string[],
	agentDefault: BoardCardAgentDefault | null = null,
): BoardCardAgentModel {
	const { providerId, modelId, reasoningEffort } = agentSettings ?? {};
	const latestUsedModel = usedModels[0];
	if (!modelId && latestUsedModel) {
		return {
			label: withEffort(latestUsedModel, reasoningEffort),
			detail: usedModels.length > 1 ? `Models used, latest first: ${usedModels.join(", ")}` : null,
		};
	}
	const launchSettings =
		!modelId && agentDefault?.agentId
			? resolveLaunchAgentSettings(agentDefault.agentId, agentSettings, agentDefault.agentDefaults)
			: undefined;
	if (launchSettings?.modelId) {
		return {
			label: withEffort(launchSettings.modelId, launchSettings.reasoningEffort),
			detail: "Default model for this agent (Kanban settings)",
		};
	}
	if (agentSettings === undefined) {
		return { label: null, detail: null };
	}
	const effortLabel = reasoningEffort ? reasoningEffort : !providerId && !modelId ? "Default" : null;
	if (providerId && !modelId) {
		const providerLabel = `Provider: ${providerId}`;
		return { label: effortLabel ? `${providerLabel} (${effortLabel})` : providerLabel, detail: null };
	}
	if (!modelId) {
		return { label: effortLabel ? `Default model (${effortLabel})` : null, detail: null };
	}
	return { label: effortLabel ? `${modelId} (${effortLabel})` : modelId, detail: null };
}
