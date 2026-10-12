// An agent CLI + provider + model combination, as routing and `kanban models vet` name it, and the roles the vet
// smoke test exercises (docs/team/MODELS.md "Vetting"). The kit's fallback role builds, so it is vetted as `dev`.
import { z } from "zod";

import type { RuntimeAgentId } from "../core/api-contract";

export const VETTING_ROLES = ["dev", "qa", "plan"] as const;
export const vettingRoleSchema = z.enum(VETTING_ROLES);
export type VettingRole = z.infer<typeof vettingRoleSchema>;

export interface ModelCombination {
	agentId: RuntimeAgentId;
	/** null = none named (the agent's own provider config, or Kanban's `models.providers` for Cline). */
	provider: string | null;
	/** null = the agent's own default model. */
	model: string | null;
}

/** `cline + bedrock + us.anthropic.claude-haiku-5-5`, for messages. */
export function describeCombination(combination: ModelCombination): string {
	return [combination.agentId, combination.provider ?? null, combination.model ?? "its own default model"]
		.filter((part): part is string => part !== null)
		.join(" + ");
}
