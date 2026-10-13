// Doctor row: Kanban's default model per agent CLI (config.json `agentDefaults`, the settings dialog), which a launch
// passes when a card names no model (resolveLaunchAgentSettings): one INFO line listing what is set, nothing when
// none is. Values are the user's and passed verbatim, so nothing here judges them.
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "../core/api-contract";
import type { RuntimeAgentDefaultSettings } from "../core/task-agent-settings";
import type { DoctorFinding } from "./doctor-report";

function describeDefault(settings: RuntimeTaskAgentSettings): string {
	const model = [settings.providerId, settings.modelId].filter(Boolean).join(" + ") || "the CLI's own model";
	return settings.reasoningEffort ? `${model} (effort ${settings.reasoningEffort})` : model;
}

export function checkAgentDefaults(agentDefaults: RuntimeAgentDefaultSettings): DoctorFinding[] {
	const listed = (Object.entries(agentDefaults) as Array<[RuntimeAgentId, RuntimeTaskAgentSettings | undefined]>)
		.filter((entry): entry is [RuntimeAgentId, RuntimeTaskAgentSettings] => Boolean(entry[1]))
		.map(
			([agentId, settings]) =>
				`${getRuntimeAgentCatalogEntry(agentId)?.label ?? agentId}: ${describeDefault(settings)}`,
		);
	if (listed.length === 0) {
		return [];
	}
	return [
		{
			level: "info",
			area: "setup",
			message: `Default models per agent (Kanban settings), used at launch when a card names none, the orchestrator sidebar and headless wakes included: ${listed.join("; ")}`,
		},
	];
}
