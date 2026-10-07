import type { RuntimeAgentId } from "../../src/core/api-contract";
import type { EffectiveModel } from "../../src/core/effective-agent";
import type { CardRole } from "../../src/kits/kit-schema";
import type { CardHistory, EffectiveCard } from "../../src/kits/policy";
import { createCard } from "./workspace-state-store";

export function createEffectiveCard(input: {
	agentId: RuntimeAgentId;
	model?: string | EffectiveModel | null;
	role?: CardRole;
	workspaceId?: string;
}): EffectiveCard {
	const model = typeof input.model === "string" ? { provider: null, model: input.model } : (input.model ?? null);
	return {
		card: createCard({ id: "dev-1" }),
		workspaceId: input.workspaceId ?? "ws",
		role: input.role ?? "dev",
		agentId: input.agentId,
		model,
	};
}

export function createCardHistory(failRounds: number[] = [], extraRounds = 0): CardHistory {
	return { failRounds, reworks: 0, nudges: 0, escalations: 0, handbacks: 0, extraRounds };
}
