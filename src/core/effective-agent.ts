// A card's effective agent and model: the one function every routing decision goes through (plan §4.0).
//
// The 2026-10-06 incident: the legacy kit skipped only cards whose literal `agentId` was "claude". Cards with no
// `agentId`, which ran on Claude as the workspace default, counted as Cline dev cards and were QA'd and landed on a
// board meant to be landed by the orchestrator. So nothing may decide on `card.agentId` directly:
//
//   agent: the agent the card's session actually ran on (summary.agentId), else card.agentId, else the agent
//          selected in Kanban settings.
//   model: the card's own settings, else the session's model, else the agent's own default (for Cline, the model of
//          providers.json's `lastUsedProvider`, which the Cline CLI uses when a card names none).
//
// Pure: callers pass the session summary, the selected agent and the agents' default models. Nothing calls these
// yet; the reconciler and session sync switch to them in P4-1.
import type { RuntimeAgentId, RuntimeBoardCard, RuntimeTaskSessionSummary } from "./api-contract";

export type EffectiveAgentSource = "session" | "card" | "selected";
export type EffectiveModelSource = "card" | "session" | "agent-default";

export interface EffectiveModel {
	provider: string | null;
	model: string;
}

export type EffectiveAgentCard = Pick<RuntimeBoardCard, "agentId" | "agentSettings">;
export type EffectiveAgentSession = Pick<RuntimeTaskSessionSummary, "agentId" | "modelId">;

export interface EffectiveAgentConfig {
	selectedAgentId: RuntimeAgentId;
}

export interface EffectiveModelConfig extends EffectiveAgentConfig {
	/** Each agent's own default model, when it is known (e.g. Cline's `lastUsedProvider` model). */
	agentDefaultModels?: Partial<Record<RuntimeAgentId, EffectiveModel | null>>;
}

function nonEmpty(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function resolveEffectiveAgentWithSource(
	card: EffectiveAgentCard,
	summary: EffectiveAgentSession | null | undefined,
	config: EffectiveAgentConfig,
): { agentId: RuntimeAgentId; source: EffectiveAgentSource } {
	if (summary?.agentId) {
		return { agentId: summary.agentId, source: "session" };
	}
	if (card.agentId) {
		return { agentId: card.agentId, source: "card" };
	}
	return { agentId: config.selectedAgentId, source: "selected" };
}

export function resolveEffectiveAgent(
	card: EffectiveAgentCard,
	summary: EffectiveAgentSession | null | undefined,
	config: EffectiveAgentConfig,
): RuntimeAgentId {
	return resolveEffectiveAgentWithSource(card, summary, config).agentId;
}

// Ported from archive/devteam-kit:lib/qa-route.cjs@ef523b20 (devModelOf: a Cline card without a model counts as the
// Cline CLI default) and lib/card-model.cjs@760fd36c (the card's settings win).
export function resolveEffectiveModelWithSource(
	card: EffectiveAgentCard,
	summary: EffectiveAgentSession | null | undefined,
	config: EffectiveModelConfig,
): { model: EffectiveModel; source: EffectiveModelSource } | null {
	const cardModel = nonEmpty(card.agentSettings?.modelId);
	if (cardModel) {
		return { model: { provider: nonEmpty(card.agentSettings?.providerId), model: cardModel }, source: "card" };
	}
	const sessionModel = nonEmpty(summary?.modelId);
	if (sessionModel) {
		return { model: { provider: null, model: sessionModel }, source: "session" };
	}
	const agentId = resolveEffectiveAgent(card, summary, config);
	const agentDefault = config.agentDefaultModels?.[agentId];
	return agentDefault ? { model: agentDefault, source: "agent-default" } : null;
}

export function resolveEffectiveModel(
	card: EffectiveAgentCard,
	summary: EffectiveAgentSession | null | undefined,
	config: EffectiveModelConfig,
): EffectiveModel | null {
	return resolveEffectiveModelWithSource(card, summary, config)?.model ?? null;
}

/**
 * The Cline CLI's default model from a parsed providers.json: the model of `lastUsedProvider`. Null when the file
 * has no usable entry. Ported from archive/devteam-kit:lib/qa-route.cjs@ef523b20 (clineDefaultModel).
 */
export function readClineDefaultModel(providersJson: unknown): EffectiveModel | null {
	if (!providersJson || typeof providersJson !== "object") {
		return null;
	}
	const { lastUsedProvider, providers } = providersJson as { lastUsedProvider?: unknown; providers?: unknown };
	if (typeof lastUsedProvider !== "string" || !providers || typeof providers !== "object") {
		return null;
	}
	const entry = (providers as Record<string, unknown>)[lastUsedProvider];
	const settings = entry && typeof entry === "object" ? (entry as { settings?: unknown }).settings : undefined;
	const model = settings && typeof settings === "object" ? (settings as { model?: unknown }).model : undefined;
	return typeof model === "string" && model.trim() ? { provider: lastUsedProvider, model: model.trim() } : null;
}
