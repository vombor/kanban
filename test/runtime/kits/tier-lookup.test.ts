import { describe, expect, it } from "vitest";

import { kitDocumentSchema } from "../../../src/kits/kit-schema";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { lookupTierModel } from "../../../src/kits/tier-lookup";

const kitWithTiers = (tiers: unknown, dropped: unknown = []) =>
	kitDocumentSchema.parse({ kit: 1, name: "tiers", tiers, dropped });

describe("tier lookup", () => {
	it("takes the tier's default entry", () => {
		const kit = kitWithTiers({ t: [{ model: "a" }, { provider: "bedrock", model: "b", default: true }] });
		expect(lookupTierModel(kit, "t")).toEqual({ ok: true, tier: "t", choice: { provider: "bedrock", model: "b" } });
	});

	it("takes the first entry when none is the default", () => {
		const kit = kitWithTiers({ t: [{ model: "a" }, { model: "b" }] });
		expect(lookupTierModel(kit, "t")).toMatchObject({ ok: true, choice: { provider: null, model: "a" } });
	});

	it("skips dropped models, on any provider", () => {
		const kit = kitWithTiers(
			{ t: [{ provider: "bedrock", model: "a", default: true }, { model: "b" }, { model: "c" }] },
			[{ provider: "openai-native", model: "a", why: "lost a runoff" }, { model: "b" }],
		);
		expect(lookupTierModel(kit, "t")).toMatchObject({ ok: true, choice: { model: "c" } });
	});

	it("reports a missing or empty tier", () => {
		const kit = kitWithTiers({ empty: [], gone: [{ model: "a" }] }, [{ model: "a" }]);
		expect(lookupTierModel(kit, "nope").ok).toBe(false);
		expect(lookupTierModel(kit, "empty").ok).toBe(false);
		expect(lookupTierModel(kit, "gone").ok).toBe(false);
	});

	it("resolves the team kit's tier3 to gpt-6.1-sol", () => {
		const team = getBuiltInKits().get("team");
		if (!team) {
			throw new Error("team kit missing");
		}
		expect(lookupTierModel(team, "tier3")).toMatchObject({ ok: true, choice: { model: "us.openai.gpt-6.1-sol" } });
	});

	it("makes a dev.model tier without a usable model a schema error", () => {
		const team = getBuiltInKits().get("team");
		if (!team) {
			throw new Error("team kit missing");
		}
		const emptyTier = resolveKitLayers(getDefaultKit(), team, { "dev.model": { tier: "tier1" } });
		expect(emptyTier.ok).toBe(false);
		expect(emptyTier.ok ? "" : emptyTier.error).toContain("tier1");
		const unknownTier = resolveKitLayers(getDefaultKit(), team, { "dev.model.tier": "tier9" });
		expect(unknownTier.ok).toBe(false);
	});
});
