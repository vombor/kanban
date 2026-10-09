// Provider capacity (`models.providerCapacity.<id>.maxLoadedModels`, plan §3.1): a provider that can hold only so
// many models at once. Lemonade (the local llama.cpp server) loads one LLM at a time, so a second card on another
// model makes it swap models on every request. Before recovery sends work to a card's model (a retry, a nudge, a
// resume), it waits while other In Progress cards already hold that many other models on the same provider.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@1ce45df (lemonadeBusy), generalized from "Lemonade,
// one model" to any provider with a limit.
import type { EffectiveModel } from "../core/effective-agent";

export interface CapacityCard {
	taskId: string;
	model: EffectiveModel | null;
	/** Set for another workspace's card: the QA gate counts every project's cards on a provider (one machine). */
	workspaceId?: string;
}

export interface ProviderCapacityHold {
	provider: string;
	maxLoadedModels: number;
	/** Models the provider holds now (at least `maxLoadedModels`). */
	loadedModels: number;
	/** The caller's own In Progress cards holding the other models, "<taskId> (<model>)". */
	holders: string[];
	/** Other workspaces' cards holding them, only counted: their cards are theirs. */
	otherWorkspaceHolders: number;
}

/** Null when the card's model may run now; otherwise who holds the provider. */
export function findProviderCapacityHold(input: {
	taskId: string;
	model: EffectiveModel | null;
	/** The workspace's other In Progress cards with their effective models (other workspaces' carry `workspaceId`). */
	inProgress: readonly CapacityCard[];
	capacity: Readonly<Record<string, { maxLoadedModels: number }>>;
}): ProviderCapacityHold | null {
	const provider = input.model?.provider ?? null;
	const limit = provider ? input.capacity[provider] : undefined;
	if (!provider || !limit || !input.model) {
		return null;
	}
	const loaded = new Map<string, CapacityCard[]>();
	for (const other of input.inProgress) {
		const self = other.taskId === input.taskId && other.workspaceId === undefined;
		if (self || other.model?.provider !== provider) {
			continue;
		}
		loaded.set(other.model.model, [...(loaded.get(other.model.model) ?? []), other]);
	}
	if (loaded.has(input.model.model) || loaded.size < limit.maxLoadedModels) {
		return null;
	}
	const holders = [...loaded].flatMap(([model, cards]) => cards.map((card) => ({ card, model })));
	return {
		provider,
		maxLoadedModels: limit.maxLoadedModels,
		loadedModels: loaded.size,
		holders: holders.filter(({ card }) => !card.workspaceId).map(({ card, model }) => `${card.taskId} (${model})`),
		otherWorkspaceHolders: holders.filter(({ card }) => card.workspaceId).length,
	};
}
