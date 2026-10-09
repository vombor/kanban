// A resolved kit's roles (`roles.<role>`, kit-schema.ts) as concrete agents and models, and its fallback flow. The
// routing policy, `kanban kit show`, doctor and the bench commands read roles only through here, never the raw
// `roles` section, so a tier reference is looked up the same way everywhere.
import type { RuntimeAgentId } from "../core/api-contract";
import {
	KIT_ROLE_NAMES,
	type KitDocument,
	type KitFallbackTrigger,
	type KitFallbackTriggers,
	type KitRoleName,
} from "./kit-schema";
import { type KitModelChoice, lookupTierModel } from "./tier-lookup";

export interface KitRoleAssignment {
	role: KitRoleName;
	/** None: the agent selected in Kanban settings (dev, plan); for the fallback, the dev role's agent or the card's. */
	agentId: RuntimeAgentId | null;
	/** None: the agent's own default model. */
	model: KitModelChoice | null;
	/** The tier the model came from. */
	tier: string | null;
	/** Set when `roles.<role>.tier` has no usable model (the resolver refuses such a kit, so only a guard). */
	error: string | null;
}

/** The role as the kit defines it, or null when the kit has no such role. */
export function resolveKitRole(kit: KitDocument, role: KitRoleName): KitRoleAssignment | null {
	const entry = kit.roles?.[role];
	if (!entry) {
		return null;
	}
	const agentId = entry.agent ?? null;
	if (entry.tier !== undefined) {
		const lookup = lookupTierModel(kit, entry.tier);
		return lookup.ok
			? { role, agentId, model: lookup.choice, tier: entry.tier, error: null }
			: { role, agentId, model: null, tier: entry.tier, error: lookup.error };
	}
	const model = entry.model ? { provider: entry.provider ?? null, model: entry.model } : null;
	return { role, agentId, model, tier: null, error: null };
}

/** The roles a kit defines, in schema order. */
export function listKitRoles(kit: KitDocument): KitRoleAssignment[] {
	return KIT_ROLE_NAMES.flatMap((role) => {
		const assignment = resolveKitRole(kit, role);
		return assignment ? [assignment] : [];
	});
}

export const FALLBACK_TRIGGERS: readonly KitFallbackTrigger[] = [
	"qaFails",
	"qaStalled",
	"unchanged",
	"conflict",
	"outage",
] as const;

export interface KitFallbackFlow {
	role: KitRoleAssignment | null;
	triggers: Required<KitFallbackTriggers>;
	/** None: `pipeline.recovery.outage.maxMin`. */
	outageAfterMin: number | null;
	requireApproval: boolean;
}

export function getKitFallbackFlow(kit: KitDocument): KitFallbackFlow {
	const on = kit.fallback?.on ?? {};
	return {
		role: resolveKitRole(kit, "fallback"),
		triggers: {
			qaFails: on.qaFails === true,
			qaStalled: on.qaStalled === true,
			unchanged: on.unchanged === true,
			conflict: on.conflict === true,
			outage: on.outage === true,
		},
		outageAfterMin: kit.fallback?.outageAfterMin ?? null,
		requireApproval: kit.fallback?.requireApproval === true,
	};
}
