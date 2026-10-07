import { describe, expect, it } from "vitest";

import { applyCardProviderMigrations, planCardProviderMigrations } from "../../../src/models/card-provider-migration";
import type { ProvidersPolicy } from "../../../src/models/cline-providers";
import { createBoard, createCard, findCardInBoard } from "../../utilities/workspace-state-store";

const POLICY: ProvidersPolicy = {
	default: "bedrock",
	fallback: { "moonshotai.kimi-k3": "lemonade" },
	deprecated: { "openai-native": "Mantle", "models.json:mantle": "unused" },
};

describe("--migrate-cards", () => {
	const board = createBoard({
		backlog: [
			createCard({
				id: "b1",
				agentId: "cline",
				agentSettings: { providerId: "openai-native", modelId: "us.openai.gpt-6.1-sol" },
			}),
			// No agentId: the card runs on the selected agent; its provider setting still moves.
			createCard({
				id: "b2",
				agentSettings: { providerId: "openai-native", modelId: "moonshotai.kimi-k3", reasoningEffort: "high" },
			}),
			createCard({ id: "b3", agentSettings: { providerId: "lemonade", modelId: "Qwen3-Coder-Next-GGUF" } }),
			createCard({ id: "b4", agentSettings: { providerId: "openai-native" } }),
		],
		in_progress: [createCard({ id: "p1", agentSettings: { providerId: "openai-native", modelId: "zai.glm-5" } })],
		review: [createCard({ id: "r1", agentSettings: { providerId: "mantle", modelId: "zai.glm-5" } })],
		trash: [createCard({ id: "t1", agentSettings: { providerId: "openai-native", modelId: "zai.glm-5" } })],
	});

	it("plans open cards on a deprecated provider, same model, and skips Done and model-less cards", () => {
		expect(planCardProviderMigrations(board, POLICY)).toEqual([
			{ taskId: "b1", column: "backlog", model: "us.openai.gpt-6.1-sol", from: "openai-native", to: "bedrock" },
			{ taskId: "b2", column: "backlog", model: "moonshotai.kimi-k3", from: "openai-native", to: "lemonade" },
			{ taskId: "p1", column: "in_progress", model: "zai.glm-5", from: "openai-native", to: "bedrock" },
		]);
	});

	it("changes only the provider id", () => {
		const migrations = planCardProviderMigrations(board, POLICY);
		const next = applyCardProviderMigrations(board, migrations, 42);
		expect(findCardInBoard(next, "b2")?.card).toMatchObject({
			agentSettings: { providerId: "lemonade", modelId: "moonshotai.kimi-k3", reasoningEffort: "high" },
			updatedAt: 42,
		});
		expect(findCardInBoard(next, "b1")?.card.agentId).toBe("cline");
		expect(findCardInBoard(next, "b3")?.card).toBe(findCardInBoard(board, "b3")?.card);
		expect(findCardInBoard(next, "t1")?.card.agentSettings?.providerId).toBe("openai-native");
		expect(planCardProviderMigrations(next, POLICY)).toEqual([]);
	});

	it("does nothing with no deprecated providers configured", () => {
		expect(planCardProviderMigrations(board, { default: "bedrock", fallback: {}, deprecated: {} })).toEqual([]);
	});
});
