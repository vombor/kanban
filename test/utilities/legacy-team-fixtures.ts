import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mapLegacyKitConfig } from "../../src/config/import-kit";
import { type RuntimeAgentId, type RuntimeBoardCard, runtimeBoardCardSchema } from "../../src/core/api-contract";
import { readClineDefaultModel } from "../../src/core/effective-agent";
import { createRoutingPolicy, type EffectiveCard, type RoutingPolicy } from "../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../src/kits/resolve-kit";
import { toEffectiveCard } from "../../src/pipeline/engine";

// Fixtures taken from the legacy kit before cutover (test/runtime/kits/fixtures/legacy-team/generate.cjs): a copy of
// the live kit.config.json (2026-10-07), the cards, and what the legacy code answered for them.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "kits", "fixtures", "legacy-team");

function readFixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

export interface LegacyCard {
	id: string;
	agentId?: RuntimeAgentId;
	agentSettings?: { providerId?: string; modelId?: string };
	title?: string;
	prompt?: string;
}

/** One line of `qa/qa-card.cjs <dev> --dry-run` (lib/qa-route.cjs qaRouteFor). */
export interface LegacyQaRoute {
	name: string;
	card: LegacyCard;
	devModel: string | null;
	qaAgent: RuntimeAgentId;
	qaProvider: string | null;
	qaModel: string | null;
	route: number | null;
	rules: string[];
}

/** qa/qa-card.cjs buildPrompt for foo. */
export interface LegacyQaPrompt {
	name: string;
	card: LegacyCard & { prompt: string };
	round: number;
	qaId: string;
	short: string;
	qaLog: string;
	rules: string[];
	prompt: string;
}

interface LegacyCardsFixture {
	clineProvidersJson: unknown;
}

export const readLegacyKitConfig = () => readFixture<Record<string, unknown>>("kit.config.json");
export const readLegacyQaRoutes = () => readFixture<LegacyQaRoute[]>("qa-routes.json");
export const readLegacyQaPrompts = () => readFixture<LegacyQaPrompt[]>("qa-prompts.json");

/** The legacy kit's qaOutRoot default (lib/config.cjs DEFAULTS), which the live file does not set. */
export const LEGACY_QA_OUT_ROOT = "/tmp/qa-out";

/** foo's overrides as `kanban config import-kit` maps the live kit.config.json. */
export function getFooImportedOverrides(): Record<string, unknown> {
	const foo = mapLegacyKitConfig(readLegacyKitConfig(), "kit.config.json").workspaces.find(
		(workspace) => workspace.workspaceId === "foo",
	);
	if (!foo || foo.kit !== "team") {
		throw new Error("the live kit.config.json no longer maps foo to the team kit");
	}
	return foo.overrides;
}

/** The `team` kit with `overrides`, resolved over `default` (as resolveWorkspaceKit does). */
export function createTeamPolicy(overrides: Record<string, unknown> = {}): RoutingPolicy {
	const team = getBuiltInKits().get("team");
	if (!team) {
		throw new Error("team kit missing");
	}
	const resolved = resolveKitLayers(getDefaultKit(), team, overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return createRoutingPolicy(resolved.kit);
}

/**
 * A fixture card as the pipeline hands it to the kit: through the board schema and toEffectiveCard, with no session,
 * Claude as the selected agent (the live setting) and the fixture providers.json as Cline's default model.
 */
export function toFooEffectiveCard(card: LegacyCard): EffectiveCard {
	const parsed: RuntimeBoardCard = runtimeBoardCardSchema.parse({
		prompt: "",
		startInPlanMode: false,
		baseRef: "master",
		createdAt: 0,
		updatedAt: 0,
		...card,
	});
	const cline = readClineDefaultModel(readFixture<LegacyCardsFixture>("cards.json").clineProvidersJson);
	return toEffectiveCard({
		card: parsed,
		session: null,
		workspaceId: "foo",
		selectedAgentId: "claude",
		agentDefaultModels: { cline },
	}).effective;
}
