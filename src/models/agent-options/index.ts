import { readPipelineConfig } from "../../config/pipeline-config";
import { getRuntimeAgentCatalogEntry } from "../../core/agent-catalog";
import type { AgentSettingsOptions } from "../../core/agent-settings-options";
import type { RuntimeAgentId } from "../../core/api-contract";
import { getClineModelsSettingsPath } from "../../state/kanban-home";
import { isBinaryAvailableOnPath } from "../../terminal/command-discovery";
import { readClaudeOptions } from "./claude-options";
import { readCodexOptions } from "./codex-options";
import { readCopilotOptions } from "./copilot-options";
import { readDroidOptions } from "./droid-options";
import { readClineOptions } from "./local-options";

export type AgentOptionsReader = (agentId: RuntimeAgentId) => Promise<AgentSettingsOptions>;

export async function readAgentSettingsOptions(agentId: RuntimeAgentId): Promise<AgentSettingsOptions> {
	const agent = getRuntimeAgentCatalogEntry(agentId);
	const empty: AgentSettingsOptions = { models: [], providers: [], efforts: [], source: agent?.label ?? agentId };
	if (agent?.capabilities.modelOverride === "none") return empty;
	if (!agent || !isBinaryAvailableOnPath(agent.binary))
		return { ...empty, error: `${agent?.label ?? agentId} is not installed.` };
	try {
		switch (agentId) {
			case "claude":
				return await readClaudeOptions();
			case "codex":
				return await readCodexOptions();
			case "cline":
				return await readClineOptions(
					getClineModelsSettingsPath((await readPipelineConfig()).config.agents.cline.dataDir),
				);
			case "copilot":
				return await readCopilotOptions();
			case "droid":
				return await readDroidOptions();
			default:
				return empty;
		}
	} catch {
		// CLI failures may contain auth details; return a scoped diagnostic, never raw stderr/errors.
		return { ...empty, error: `Could not load ${agent.label}'s available models. Its stored default is kept.` };
	}
}

/** Lazy, deduplicated discovery: only the selected agent is queried; repeated opens share a short-lived cache. */
export function createAgentOptionsLoader(
	read: AgentOptionsReader = readAgentSettingsOptions,
	now = Date.now,
): AgentOptionsReader {
	const cache = new Map<RuntimeAgentId, { expires: number; value: Promise<AgentSettingsOptions> }>();
	return async (agentId) => {
		const existing = cache.get(agentId);
		if (existing && existing.expires > now()) return await existing.value;
		const value = read(agentId);
		cache.set(agentId, { expires: now() + 60_000, value });
		try {
			return await value;
		} catch (error) {
			cache.delete(agentId);
			throw error;
		}
	};
}
