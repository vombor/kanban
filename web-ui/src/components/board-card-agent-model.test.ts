import { describe, expect, it } from "vitest";

import { describeBoardCardAgentModel } from "@/components/board-card-agent-model";

describe("describeBoardCardAgentModel", () => {
	const defaults = {
		agentId: "codex" as const,
		agentDefaults: { codex: { modelId: "sol", reasoningEffort: "high" } },
	};

	it("prefers the card's model, then the used model, then the agent's default", () => {
		expect(describeBoardCardAgentModel({ modelId: "gpt-x" }, ["used"], defaults)).toEqual({
			label: "gpt-x",
			detail: null,
		});
		expect(describeBoardCardAgentModel(undefined, ["used"], defaults)).toEqual({ label: "used", detail: null });
		expect(describeBoardCardAgentModel(undefined, [], defaults)).toEqual({
			label: "sol (high)",
			detail: "Default model for this agent (Kanban settings)",
		});
		expect(describeBoardCardAgentModel({ reasoningEffort: "low" }, [], defaults).label).toBe("sol (low)");
	});

	it("falls back to the card's settings without a default for the agent", () => {
		expect(
			describeBoardCardAgentModel(undefined, [], { agentId: "claude", agentDefaults: defaults.agentDefaults }),
		).toEqual({ label: null, detail: null });
		expect(describeBoardCardAgentModel({ reasoningEffort: "low" }, [], null).label).toBe("Default model (low)");
		expect(describeBoardCardAgentModel({}, [], { agentId: null, agentDefaults: defaults.agentDefaults }).label).toBe(
			"Default model (Default)",
		);
	});
});
