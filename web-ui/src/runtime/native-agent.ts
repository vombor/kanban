import { isRuntimeAgentLaunchSupported } from "@runtime-agent-catalog";
import type { RuntimeConfigResponse } from "@/runtime/types";

// Every task agent (Cline included) is an installed CLI that runs in a terminal, so setup is
// satisfied as soon as one launch-supported agent is installed.
export function isTaskAgentSetupSatisfied(
	config: Pick<RuntimeConfigResponse, "selectedAgentId" | "agents"> | null | undefined,
): boolean | null {
	if (!config) {
		return null;
	}
	return config.agents.some((agent) => isRuntimeAgentLaunchSupported(agent.id) && agent.installed);
}

// The display name of the workspace's selected agent (e.g. "Claude Code"), or null before the config loads.
export function getSelectedAgentLabel(
	config: Pick<RuntimeConfigResponse, "selectedAgentId" | "agents"> | null | undefined,
): string | null {
	if (!config) {
		return null;
	}
	return config.agents.find((agent) => agent.id === config.selectedAgentId)?.label ?? null;
}

export function getTaskAgentNavbarHint(
	config: Pick<RuntimeConfigResponse, "selectedAgentId" | "agents"> | null | undefined,
	options?: {
		shouldUseNavigationPath?: boolean;
	},
): string | undefined {
	if (options?.shouldUseNavigationPath) {
		return undefined;
	}
	const isTaskAgentReady = isTaskAgentSetupSatisfied(config);
	if (isTaskAgentReady === null || isTaskAgentReady) {
		return undefined;
	}
	return "No agent configured";
}
