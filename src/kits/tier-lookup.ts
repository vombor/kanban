// Tier → model lookup for `dev.model: { tier }` (plan §3.2). Data only: the tier's entry marked `default`, else
// its first entry, skipping models listed in `dropped`. Escalating to a tier (`escalate.to: { tier }`) and
// `kanban bench tiers` are the team kit's `tiers` feature (P4-T3); they use this same lookup.
import { getUsableTierEntries, type KitDocument, type KitModelRef } from "./kit-schema";

export interface KitModelChoice {
	provider: string | null;
	model: string;
}

export type TierLookupResult = { ok: true; choice: KitModelChoice; tier: string | null } | { ok: false; error: string };

export function lookupTierModel(kit: KitDocument, tier: string): TierLookupResult {
	if (!kit.tiers || !Object.hasOwn(kit.tiers, tier)) {
		return { ok: false, error: `tier "${tier}" is not in kit "${kit.name}"` };
	}
	const usable = getUsableTierEntries(kit, tier);
	const entry = usable.find((candidate) => candidate.default === true) ?? usable[0];
	if (!entry) {
		return { ok: false, error: `tier "${tier}" of kit "${kit.name}" has no model that isn't dropped` };
	}
	return { ok: true, tier, choice: { provider: entry.provider ?? null, model: entry.model } };
}

/** A kit model reference (`{ tier }` or `{ provider?, model }`) as a concrete model. */
export function resolveKitModelRef(kit: KitDocument, ref: KitModelRef): TierLookupResult {
	if ("tier" in ref) {
		return lookupTierModel(kit, ref.tier);
	}
	return { ok: true, tier: null, choice: { provider: ref.provider ?? null, model: ref.model } };
}
