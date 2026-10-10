// The runtime side of `kanban models vet`'s capacity wait (issue #25): whether a model may run on its provider now,
// under `models.providerCapacity`, counted over every project's In Progress cards with their effective models, as the
// QA gate counts them (findProviderCapacityHold, src/pipeline/provider-capacity.ts). The vet card runs outside the
// pipeline worker and can't read other projects' boards, so the server answers. Other projects' cards are only
// counted: the answer names the asking project's own holders and a number for the rest, never another project's
// card ids or models.
import { z } from "zod";

import { type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardData, RuntimeTaskSessionSummary } from "../core/api-contract";
import { type EffectiveModelConfig, resolveEffectiveModel } from "../core/effective-agent";
import { type CapacityCard, findProviderCapacityHold } from "../pipeline/provider-capacity";

export const providerCapacityRequestSchema = z.object({
	provider: z.string().min(1),
	model: z.string().min(1),
});

export const providerCapacityResponseSchema = z.object({
	/** Null when the model may run now. */
	hold: z
		.object({
			provider: z.string(),
			maxLoadedModels: z.number(),
			loadedModels: z.number(),
			/** The asking project's In Progress cards holding the other models, "<taskId> (<model>)". */
			holders: z.array(z.string()),
			/** Other projects' cards holding them, only counted. */
			otherWorkspaceHolders: z.number(),
		})
		.nullable(),
});
export type ProviderCapacityResponse = z.infer<typeof providerCapacityResponseSchema>;

export interface ProviderCapacityWorkspace {
	board: RuntimeBoardData;
	/** The workspace's session summaries (live ones where the server has them). */
	sessions: readonly RuntimeTaskSessionSummary[];
	selectedAgentId: RuntimeAgentId;
}

export interface RuntimeProviderCapacityApi {
	check: (input: {
		workspaceId: string;
		request: z.infer<typeof providerCapacityRequestSchema>;
	}) => Promise<ProviderCapacityResponse>;
}

export interface CreateProviderCapacityApiDependencies {
	/** Every workspace the server has open: a card that runs is in one of them. */
	listWorkspaceIds: () => string[];
	loadWorkspace: (workspaceId: string) => Promise<ProviderCapacityWorkspace | null>;
	readConfig?: () => Promise<ParsedPipelineConfig>;
	/** Each agent's own default model (readAgentDefaultModels), for cards that name none. */
	loadAgentDefaultModels: (config: ParsedPipelineConfig) => Promise<EffectiveModelConfig["agentDefaultModels"]>;
}

function listInProgressCards(
	workspace: ProviderCapacityWorkspace,
	agentDefaultModels: EffectiveModelConfig["agentDefaultModels"],
): Array<{ taskId: string; model: CapacityCard["model"] }> {
	const sessions = new Map(workspace.sessions.map((session) => [session.taskId, session]));
	return workspace.board.columns
		.filter((column) => column.id === "in_progress")
		.flatMap((column) => column.cards)
		.map((card) => ({
			taskId: card.id,
			model: resolveEffectiveModel(card, sessions.get(card.id) ?? null, {
				selectedAgentId: workspace.selectedAgentId,
				agentDefaultModels,
			}),
		}));
}

export function createProviderCapacityApi(deps: CreateProviderCapacityApiDependencies): RuntimeProviderCapacityApi {
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	return {
		check: async ({ workspaceId, request }) => {
			const config = await readConfig();
			const capacity = config.config.models.providerCapacity;
			if (!capacity[request.provider]) {
				return { hold: null };
			}
			const agentDefaultModels = await deps.loadAgentDefaultModels(config);
			const inProgress: CapacityCard[] = [];
			for (const id of new Set([workspaceId, ...deps.listWorkspaceIds()])) {
				const workspace = await deps.loadWorkspace(id).catch(() => null);
				if (!workspace) {
					continue;
				}
				for (const card of listInProgressCards(workspace, agentDefaultModels)) {
					inProgress.push(id === workspaceId ? card : { ...card, workspaceId: id });
				}
			}
			const hold = findProviderCapacityHold({
				// No card yet: the run asks before it creates one.
				taskId: "",
				model: { provider: request.provider, model: request.model },
				inProgress,
				capacity,
			});
			return { hold };
		},
	};
}
