import { describe, expect, it } from "vitest";

import { getRuntimeLaunchSupportedAgentCatalog } from "../../../src/core/agent-catalog";
import {
	getAgentDefaultSettings,
	normalizeRuntimeAgentDefaultSettings,
	resolveLaunchAgentSettings,
} from "../../../src/core/task-agent-settings";

describe("resolveLaunchAgentSettings", () => {
	const agents = getRuntimeLaunchSupportedAgentCatalog();

	it.each(agents.map((agent) => [agent.id, agent.capabilities] as const))(
		"%s: the card's model (its own or its kit role's) > the agent's default > none",
		(agentId, capabilities) => {
			const defaults = {
				[agentId]: { providerId: "p-default", modelId: "m-default", reasoningEffort: "e-default" },
			};
			const supportedDefault = getAgentDefaultSettings(agentId, defaults);

			// The card (or the kit role written onto it) names a model: kept as is, no default provider or effort.
			expect(resolveLaunchAgentSettings(agentId, { modelId: "m-card" }, defaults)).toEqual({ modelId: "m-card" });
			// No model on the card: the default, fields the CLI can't take at launch dropped.
			expect(resolveLaunchAgentSettings(agentId, undefined, defaults)).toEqual(supportedDefault);
			if (capabilities.modelOverride === "none") {
				expect(supportedDefault).toBeUndefined();
			} else {
				expect(supportedDefault?.modelId).toBe("m-default");
				expect(supportedDefault?.reasoningEffort).toBe(
					capabilities.effortOverride === "none" ? undefined : "e-default",
				);
				expect(supportedDefault?.providerId).toBe(
					capabilities.providerOverride === "none" ? undefined : "p-default",
				);
			}
			// No default: the card's settings (none at all = the CLI's own config).
			expect(resolveLaunchAgentSettings(agentId, undefined, {})).toBeUndefined();
			expect(resolveLaunchAgentSettings(agentId, { reasoningEffort: "low" }, {})).toEqual({
				reasoningEffort: "low",
			});
		},
	);

	it("lets a card's own effort or provider win over the default's when it names no model", () => {
		const defaults = { cline: { providerId: "lemonade", modelId: "Qwen3-Coder", reasoningEffort: "high" } };
		expect(resolveLaunchAgentSettings("cline", { reasoningEffort: "low" }, defaults)).toEqual({
			providerId: "lemonade",
			modelId: "Qwen3-Coder",
			reasoningEffort: "low",
		});
		expect(resolveLaunchAgentSettings("cline", { providerId: "bedrock" }, defaults)).toEqual({
			providerId: "bedrock",
			modelId: "Qwen3-Coder",
			reasoningEffort: "high",
		});
	});

	it("uses only the launched agent's default", () => {
		expect(resolveLaunchAgentSettings("claude", undefined, { codex: { modelId: "sol" } })).toBeUndefined();
	});
});

describe("normalizeRuntimeAgentDefaultSettings", () => {
	it("trims values, drops empty entries, unknown agents and fields the agent can't take, reads cline-cli as cline", () => {
		expect(
			normalizeRuntimeAgentDefaultSettings({
				codex: { modelId: " sol ", reasoningEffort: " high ", providerId: "mantle" },
				claude: { modelId: "" },
				kiro: { modelId: "anything" },
				"cline-cli": { providerId: "lemonade", modelId: "Qwen3-Coder" },
				nope: { modelId: "x" },
				copilot: "gpt-5",
			}),
		).toEqual({
			codex: { modelId: "sol", reasoningEffort: "high" },
			cline: { providerId: "lemonade", modelId: "Qwen3-Coder" },
		});
		expect(normalizeRuntimeAgentDefaultSettings(null)).toEqual({});
		expect(normalizeRuntimeAgentDefaultSettings([])).toEqual({});
	});

	it("serializes equal values the same whatever the key order", () => {
		expect(
			JSON.stringify(normalizeRuntimeAgentDefaultSettings({ codex: { modelId: "a" }, claude: { modelId: "b" } })),
		).toBe(
			JSON.stringify(normalizeRuntimeAgentDefaultSettings({ claude: { modelId: "b" }, codex: { modelId: "a" } })),
		);
	});
});
