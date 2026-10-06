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
