import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type KitDocument, kitDocumentObjectSchema } from "../../src/kits/kit-schema";
import { createRoutingPolicy, type RoutingPolicy } from "../../src/kits/policy";
import { getBuiltInKits, getBuiltInPresets, getDefaultKit, resolveKitLayers } from "../../src/kits/resolve-kit";

const LEGACY_TEAM_KIT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"runtime",
	"kits",
	"fixtures",
	"legacy-team-kit.json",
);

/**
 * A full team kit with tiers (tier3, tier2, qa), a QA route and runoffs: the built-in team-cloud kit as it was before
 * the team kit and its presets (2026-10-12), kept for the tests of mechanics that need such a kit. Named
 * `legacy-team`, so it can also be written into a test kits dir as a user kit.
 */
export function getLegacyTeamKit(): KitDocument {
	return kitDocumentObjectSchema.parse(JSON.parse(readFileSync(LEGACY_TEAM_KIT_PATH, "utf8")));
}

/** The legacy team kit's file content, for a test kits dir (`<kitsDir>/legacy-team.json`). */
export function readLegacyTeamKitText(): string {
	return readFileSync(LEGACY_TEAM_KIT_PATH, "utf8");
}

/** The built-in team kit, with `preset`'s models (null: a custom team), resolved over default. */
export function resolveTeamKit(preset: string | null, overrides: Record<string, unknown> = {}): KitDocument {
	const team = getBuiltInKits().get("team");
	const presetDocument = preset === null ? null : getBuiltInPresets().get(preset);
	if (!team || presetDocument === undefined) {
		throw new Error(`team kit or preset ${preset} missing`);
	}
	const resolved = resolveKitLayers(getDefaultKit(), team, overrides, presetDocument);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved.kit;
}

/** The legacy team kit with `overrides`, resolved over default (as resolveWorkspaceKit does). */
export function resolveLegacyTeamKit(overrides: Record<string, unknown> = {}): KitDocument {
	const resolved = resolveKitLayers(getDefaultKit(), getLegacyTeamKit(), overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved.kit;
}

export function createLegacyTeamPolicy(overrides: Record<string, unknown> = {}): RoutingPolicy {
	return createRoutingPolicy(resolveLegacyTeamKit(overrides));
}
