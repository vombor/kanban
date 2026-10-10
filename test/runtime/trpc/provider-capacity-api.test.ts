import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { createProviderCapacityApi, type ProviderCapacityWorkspace } from "../../../src/trpc/provider-capacity-api";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

function onLemonade(id: string, model: string): RuntimeBoardCard {
	return createCard({ id, agentId: "cline", agentSettings: { providerId: "lemonade", modelId: model } });
}

function workspace(inProgress: RuntimeBoardCard[], review: RuntimeBoardCard[] = []): ProviderCapacityWorkspace {
	return { board: createBoard({ in_progress: inProgress, review }), sessions: [], selectedAgentId: "cline" };
}

function createApi(workspaces: Record<string, ProviderCapacityWorkspace>, maxLoadedModels = 2) {
	return createProviderCapacityApi({
		listWorkspaceIds: () => Object.keys(workspaces),
		loadWorkspace: async (workspaceId) => workspaces[workspaceId] ?? null,
		readConfig: async () => parsePipelineConfig({ models: { providerCapacity: { lemonade: { maxLoadedModels } } } }),
		// A card that names no model runs on Cline's own default.
		loadAgentDefaultModels: async () => ({ cline: { provider: "lemonade", model: "Qwen3.6-35B-A3B-MTP-GGUF" } }),
	});
}

describe("provider capacity for kanban models vet (issue #25)", () => {
	it("counts every project's In Progress cards, naming only the asking project's own", async () => {
		const api = createApi({
			"kanban-2uge": workspace([], [onLemonade("r0001", "Gemma-4-12B-it-GGUF")]),
			notes: workspace([onLemonade("d2222", "GLM-4.7-Flash-GGUF"), onLemonade("q3333", "Gemma-4-12B-it-GGUF")]),
		});
		const { hold } = await api.check({
			workspaceId: "kanban-2uge",
			request: { provider: "lemonade", model: "Devstral-Small-2507-GGUF" },
		});
		expect(hold).toEqual({
			provider: "lemonade",
			maxLoadedModels: 2,
			loadedModels: 2,
			holders: [],
			otherWorkspaceHolders: 2,
		});
	});

	it("lets a model run that is already loaded, or while the provider has room", async () => {
		const notes = workspace([onLemonade("d2222", "GLM-4.7-Flash-GGUF"), onLemonade("q3333", "Gemma-4-12B-it-GGUF")]);
		const api = createApi({ "kanban-2uge": workspace([]), notes });
		const loaded = await api.check({
			workspaceId: "kanban-2uge",
			request: { provider: "lemonade", model: "GLM-4.7-Flash-GGUF" },
		});
		expect(loaded.hold).toBeNull();
		const roomy = createApi({ "kanban-2uge": workspace([]), notes }, 3);
		expect(
			(await roomy.check({ workspaceId: "kanban-2uge", request: { provider: "lemonade", model: "Devstral" } })).hold,
		).toBeNull();
		// A provider without a limit.
		expect(
			(await api.check({ workspaceId: "kanban-2uge", request: { provider: "bedrock", model: "us.x" } })).hold,
		).toBeNull();
	});

	it("reads a card's model through its effective model (the agent's default for a card that names none)", async () => {
		const api = createApi({
			"kanban-2uge": workspace([createCard({ id: "c0001", agentId: "cline" })]),
			notes: workspace([onLemonade("d2222", "GLM-4.7-Flash-GGUF")]),
		});
		const { hold } = await api.check({
			workspaceId: "kanban-2uge",
			request: { provider: "lemonade", model: "Devstral-Small-2507-GGUF" },
		});
		expect(hold).toMatchObject({ holders: ["c0001 (Qwen3.6-35B-A3B-MTP-GGUF)"], otherWorkspaceHolders: 1 });
	});
});
