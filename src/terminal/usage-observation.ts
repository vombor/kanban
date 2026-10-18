import { createHash } from "node:crypto";
import type { AgentUsageObservation } from "../core/agent-usage-observation";
import type { TokenCounts } from "./agent-token-usage";

export const usageSourceKey = (agent: string, identity: string): string =>
	`${agent}:${createHash("sha256").update(identity).digest("hex")}`;
export function usageObservation(input: {
	agent: AgentUsageObservation["agent"];
	identity: string;
	stable: boolean;
	at: number;
	model: unknown;
	provider?: unknown;
	tokens: TokenCounts | null;
	cacheKnown: boolean;
	basis?: AgentUsageObservation["basis"];
	mixed?: boolean;
	generationError?: boolean;
}): AgentUsageObservation {
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
	const model = input.mixed ? null : text(input.model),
		provider = text(input.provider);
	const uncertainty: AgentUsageObservation["uncertainty"] = [];
	if (!input.stable) uncertainty.push("identity_missing");
	if (input.at <= 0) uncertainty.push("time_missing");
	if (!input.tokens) uncertainty.push("usage_missing");
	if (!input.cacheKnown && input.tokens) uncertainty.push("cache_breakdown_missing");
	if (!provider) uncertainty.push("provider_missing");
	if (!model) uncertainty.push(input.mixed ? "mixed_model" : "model_missing");
	if (input.generationError) uncertainty.push("generation_error");
	return {
		key: usageSourceKey(input.agent, input.identity),
		agent: input.agent,
		basis: input.basis ?? "request",
		at: input.at > 0 ? input.at : null,
		model,
		provider,
		tokens: input.tokens,
		uncertainty,
	};
}
export const hasUsageNumbers = (...values: unknown[]): boolean =>
	values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
