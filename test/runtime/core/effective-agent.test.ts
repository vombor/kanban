import { describe, expect, it } from "vitest";

import {
	readClineDefaultModel,
	resolveEffectiveAgent,
	resolveEffectiveAgentWithSource,
	resolveEffectiveModel,
	resolveEffectiveModelWithSource,
} from "../../../src/core/effective-agent";

describe("resolveEffectiveAgent", () => {
	it("prefers the agent the session ran on, then the card's agent, then the selected agent", () => {
		const config = { selectedAgentId: "claude" as const };
		expect(
			resolveEffectiveAgentWithSource({ agentId: "codex" }, { agentId: "cline", modelId: null }, config),
		).toEqual({ agentId: "cline", source: "session" });
		expect(resolveEffectiveAgentWithSource({ agentId: "codex" }, null, config)).toEqual({
			agentId: "codex",
			source: "card",
		});
		expect(resolveEffectiveAgentWithSource({}, { agentId: null, modelId: null }, config)).toEqual({
			agentId: "claude",
			source: "selected",
		});
	});

	it("gives a card with no agentId the workspace default, never undefined or another agent (2026-10-06)", () => {
		expect(resolveEffectiveAgent({}, undefined, { selectedAgentId: "claude" })).toBe("claude");
	});

	it("keeps a running Claude session on Claude when the global default changes", () => {
		const session = { agentId: "claude" as const, modelId: null };
		expect(resolveEffectiveAgent({}, session, { selectedAgentId: "cline" })).toBe("claude");
	});
});

describe("resolveEffectiveModel", () => {
	const clineDefault = { provider: "bedrock", model: "us.openai.gpt-6.1-sol" };

	it("prefers the card's settings, then the session's model, then the agent's default", () => {
		const config = { selectedAgentId: "cline" as const, agentDefaultModels: { cline: clineDefault } };
		expect(
			resolveEffectiveModelWithSource(
				{ agentId: "cline", agentSettings: { providerId: "bedrock", modelId: "card-model" } },
				{ agentId: "cline", modelId: "session-model" },
				config,
			),
		).toEqual({ model: { provider: "bedrock", model: "card-model" }, source: "card" });
		expect(
			resolveEffectiveModelWithSource({ agentId: "cline" }, { agentId: "cline", modelId: "session-model" }, config),
		).toEqual({ model: { provider: null, model: "session-model" }, source: "session" });
		expect(resolveEffectiveModelWithSource({ agentId: "cline" }, null, config)).toEqual({
			model: clineDefault,
			source: "agent-default",
		});
	});

	it("gives a Cline card with no model the Cline CLI default from providers.json", () => {
		const providersJson = {
			lastUsedProvider: "bedrock",
			providers: { bedrock: { settings: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" } } },
		};
		const clineModel = readClineDefaultModel(providersJson);
		expect(clineModel).toEqual(clineDefault);
		// A card without an agentId on a workspace whose selected agent is Cline.
		expect(
			resolveEffectiveModel({ agentSettings: { modelId: " " } }, null, {
				selectedAgentId: "cline",
				agentDefaultModels: { cline: clineModel },
			}),
		).toEqual(clineDefault);
	});

	it("uses the effective agent's default, not another agent's", () => {
		expect(
			resolveEffectiveModel(
				{},
				{ agentId: "claude", modelId: null },
				{
					selectedAgentId: "cline",
					agentDefaultModels: { cline: clineDefault },
				},
			),
		).toBeNull();
	});

	it("reads nothing from an unusable providers.json", () => {
		expect(readClineDefaultModel(null)).toBeNull();
		expect(readClineDefaultModel({ lastUsedProvider: "x", providers: {} })).toBeNull();
		expect(
			readClineDefaultModel({ lastUsedProvider: "x", providers: { x: { settings: { model: "" } } } }),
		).toBeNull();
	});
});
