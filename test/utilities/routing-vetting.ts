// Vetting rules for tests of kit semantics (src/kits/routing-vetting.ts). The built-in team and team-local kits'
// defaults are provisional in the vetted model registry, so tests of what those kits route use the bundled registry
// with provisional combinations allowed, as a project whose user allowed them; tests with made-up models list them
// in a registry of their own.
import type { RoutingVetting } from "../../src/kits/routing-vetting";
import {
	getVettedRegistry,
	type ModelCombination,
	VETTING_ROLES,
	type VettedRegistry,
	vettedRegistrySchema,
} from "../../src/models/vetted-registry";

/** The bundled registry, provisional combinations allowed. */
export const PROVISIONAL_ALLOWED: RoutingVetting = { registry: getVettedRegistry(), allowProvisional: true };

/** The bundled registry plus `combinations` vetted for every role. */
export function createTestRegistry(combinations: ModelCombination[], base: VettedRegistry = getVettedRegistry()) {
	return vettedRegistrySchema.parse({
		registry: 1,
		entries: [
			...base.entries,
			...combinations.map((combination) => ({
				agent: combination.agentId,
				provider: combination.provider,
				model: combination.model,
				roles: Object.fromEntries(
					VETTING_ROLES.map((role) => [
						role,
						{ status: "vetted", at: "2026-10-09", cliVersion: null, evidence: { run: null, summary: "test" } },
					]),
				),
			})),
		],
	});
}
