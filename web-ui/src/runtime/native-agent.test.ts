import { describe, expect, it } from "vitest";

import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import type { RuntimeConfigResponse } from "@/runtime/types";

type AgentDefinition = RuntimeConfigResponse["agents"][number];

function createAgent(id: AgentDefinition["id"], label: string, binary: string, installed: boolean): AgentDefinition {
	return { id, label, binary, command: binary, defaultArgs: [], installed, configured: false };
}

function createRuntimeConfigResponse(
	selectedAgentId: RuntimeConfigResponse["selectedAgentId"],
	agents: AgentDefinition[],
): RuntimeConfigResponse {
	return {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: selectedAgentId,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project/.cline/kanban/config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: agents.filter((agent) => agent.installed).map((agent) => agent.binary),
		agents,
		shortcuts: [],
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
	};
}

// Cline is a CLI like every other agent: it is ready when its binary is installed, with no
// provider/OAuth setup inside Kanban.
describe("task agent setup", () => {
	it("is satisfied when the cline CLI is installed", () => {
		const config = createRuntimeConfigResponse("cline", [createAgent("cline", "Cline", "cline", true)]);
		expect(isTaskAgentSetupSatisfied(config)).toBe(true);
		expect(getTaskAgentNavbarHint(config)).toBeUndefined();
	});

	it("needs setup when no launch-supported agent is installed", () => {
		const config = createRuntimeConfigResponse("cline", [
			createAgent("cline", "Cline", "cline", false),
			createAgent("claude", "Claude Code", "claude", false),
		]);
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
		expect(getTaskAgentNavbarHint(config)).toBe("No agent configured");
		expect(getTaskAgentNavbarHint(config, { shouldUseNavigationPath: true })).toBeUndefined();
	});

	it("is satisfied by any installed launch-supported agent", () => {
		const config = createRuntimeConfigResponse("cline", [
			createAgent("cline", "Cline", "cline", false),
			createAgent("claude", "Claude Code", "claude", true),
		]);
		expect(isTaskAgentSetupSatisfied(config)).toBe(true);
	});

	it("ignores agents that are not launch-supported", () => {
		const config = createRuntimeConfigResponse("claude", [createAgent("gemini", "Gemini CLI", "gemini", true)]);
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});

	it("returns null while the config is still loading", () => {
		expect(isTaskAgentSetupSatisfied(null)).toBeNull();
		expect(getTaskAgentNavbarHint(null)).toBeUndefined();
	});
});
