import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { evaluateKitRecommendedSettings } from "../../../src/kits/kit-recommendations";
import { buildKitReport, formatKitReport } from "../../../src/kits/kit-report";
import { listKitRoutes } from "../../../src/kits/kit-routes";
import { answerPlanAssignment, createRoutingPolicy } from "../../../src/kits/policy";
import { getBuiltInKits, getBuiltInPresets, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { listKitModels } from "../../../src/kits/team/bench/price-sync-job";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";

const QWEN = { provider: "lemonade", model: "Qwen3.8-27B-GGUF-UD-Q4_K_XL" };
const MUSE = { provider: "lemonade", model: "Muse-Glimmer-30B-GGUF-Q4_K_M" };
const QWEN_CODER = { provider: "lemonade", model: "Qwen3-Coder-30B-A3B-Instruct-GGUF-Q4_K_M" };
/** The only models the preset may name (user, 2026-10-13: served on Lemonade and vetted; issue #45). */
const SERVED_MODELS = [QWEN.model, MUSE.model, QWEN_CODER.model];

/** The team kit with the lemonade preset (what team-local was until 2026-10-12). */
function resolveTeamLocal(overrides: Record<string, unknown> = {}) {
	const kit = getBuiltInKits().get("team");
	const preset = getBuiltInPresets().get("lemonade");
	if (!kit || !preset) {
		throw new Error("team kit or lemonade preset missing");
	}
	const resolved = resolveKitLayers(getDefaultKit(), kit, overrides, preset);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved;
}

/** Every { provider, model } pair anywhere in a kit document. */
function collectModelProviders(value: unknown, found: Array<{ provider: unknown; model: string }> = []) {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectModelProviders(item, found);
		}
	} else if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.model === "string") {
			found.push({ provider: record.provider, model: record.model });
		}
		for (const child of Object.values(record)) {
			collectModelProviders(child, found);
		}
	}
	return found;
}

describe("the team kit's lemonade preset", () => {
	it("routes nothing to a paid provider: every model is on lemonade, every agent is cline", () => {
		const { kit } = resolveTeamLocal();
		const models = collectModelProviders(kit);
		expect(models.length).toBeGreaterThan(5);
		expect(models.filter(({ provider }) => provider !== "lemonade")).toEqual([]);
		// The fallback has no agent of its own: it runs on the dev role's (Cline).
		expect(kit.roles?.fallback?.agent).toBeUndefined();
		const agents = [
			kit.roles?.dev?.agent,
			kit.roles?.qa?.agent,
			kit.roles?.plan?.agent,
			...(kit.qa?.routes ?? []).map((r) => r.agent),
		];
		expect(new Set(agents)).toEqual(new Set(["cline"]));
		// The team kit's one workflow: every feature, the same as every other preset.
		expect(kit.features).toEqual(["scoreboard", "bench", "runoffs", "calibration", "tiers"]);
	});

	it("names only the three served, vetted models, in the preset and in the resolved kit", () => {
		const preset = getBuiltInPresets().get("lemonade");
		for (const document of [preset, resolveTeamLocal().kit]) {
			const named = new Set(collectModelProviders(document).map(({ model }) => model));
			expect([...named].sort()).toEqual([...SERVED_MODELS].sort());
		}
	});

	it("assigns new dev cards to the dev tier's local model and plan cards to the QA model", () => {
		const { kit } = resolveTeamLocal();
		expect(
			createRoutingPolicy(kit).devAssignment({
				workspaceId: "ws",
				title: "",
				prompt: "",
				role: "dev",
			}),
		).toEqual({
			agentId: "cline",
			model: QWEN,
			tier: "dev",
		});
		expect(answerPlanAssignment(kit)).toEqual({
			kind: "plan",
			agentId: "cline",
			model: MUSE,
			startInPlanMode: true,
			rules: [],
		});
	});

	it("gives every candidate dev model QA from another family", () => {
		const policy = createRoutingPolicy(resolveTeamLocal().kit);
		const qaFor = (model: { provider: string; model: string }) =>
			policy.qaPolicy({
				dev: createEffectiveCard({ agentId: "cline", model }),
				round: 1,
				history: createCardHistory(),
			});
		expect(qaFor(QWEN)).toMatchObject({ kind: "qa", agentId: "cline", model: MUSE, route: null });
		expect(qaFor(QWEN_CODER)).toMatchObject({ kind: "qa", model: MUSE, route: null });
	});

	it("refuses QA by the dev model's own family: a dev card on the QA model gets none", () => {
		const policy = createRoutingPolicy(resolveTeamLocal().kit);
		expect(
			policy.qaPolicy({
				dev: createEffectiveCard({
					agentId: "cline",
					model: MUSE,
				}),
				round: 1,
				history: createCardHistory(),
			}),
		).toMatchObject({ kind: "none", reason: expect.stringContaining("(meta)") });
	});

	it("reworks on the same model, then hands the task to the fallback local model at once, outages included", () => {
		const policy = createRoutingPolicy(resolveTeamLocal().kit);
		const dev = createEffectiveCard({ agentId: "cline", model: QWEN });
		const limits = { maxFailRounds: 3 };
		expect(policy.onFail({ dev, cause: "fail", verdict: null, history: createCardHistory([1]), limits })).toEqual({
			action: "rework",
			clearContext: "auto",
		});
		expect(
			policy.onFail({ dev, cause: "fail", verdict: null, history: createCardHistory([1, 2, 3]), limits }),
		).toMatchObject({ action: "escalate", to: { agentId: "cline", model: QWEN_CODER }, requireApproval: false });
		// One workflow for every team (user 2026-10-12): an outage hold that lasted maxMin hands the task to the fallback
		// too. On one Lemonade server the sibling waits on the same outage, then goes to the orchestrator (a fallback
		// sibling never falls back again).
		expect(policy.onOutage({ dev, heldMin: 200, maxMin: 360 })).toMatchObject({ action: "hold" });
		expect(policy.onOutage({ dev, heldMin: 400, maxMin: 360 })).toMatchObject({
			action: "escalate",
			to: { agentId: "cline", model: QWEN_CODER },
			requireApproval: false,
		});
	});

	it("routes its roles to its local models with no overrides, as a fresh kit apply team --preset lemonade does", () => {
		const { kit } = resolveTeamLocal();
		const onCline = (model: { provider: string; model: string }) => ({ agentId: "cline", ...model });
		expect(listKitRoutes(kit)).toEqual([
			{ label: "roles.dev", combination: onCline(QWEN) },
			{ label: "roles.qa", combination: onCline(MUSE) },
			{ label: "roles.plan", combination: onCline(MUSE) },
			{ label: "roles.fallback", combination: onCline(QWEN_CODER) },
		]);
		// No text in the kit names the models it ran before 2026-10-12, or the ones it dropped on 2026-10-13 (gemma-4-E4B
		// is named only in the QA notes, as the reviewer notes found too small).
		const text = JSON.stringify(kit);
		for (const old of ["Devstral-Small-2-24B", "GLM", "98304", "Gemma-4-12B", "Laguna-XS-2.1", "gemma-4-31B"]) {
			expect(text).not.toContain(old);
		}
	});

	it("leaves its local models out of the AWS price check", () => {
		expect(listKitModels(resolveTeamLocal().kit)).toEqual([]);
	});

	it("names the settings it needs and reports which a config meets", () => {
		const { kit } = resolveTeamLocal();
		const statusOf = (raw: unknown) =>
			Object.fromEntries(
				evaluateKitRecommendedSettings(kit, parsePipelineConfig(raw).config, "local").map((entry) => [
					entry.configKey,
					entry.status,
				]),
			);
		expect(statusOf({})).toEqual({
			"agents.cline.turnDetector.mode": "unmet",
			"pipeline.recovery.mode": "unmet",
			"workspaces.local.recovery.enabled": "met",
		});
		expect(
			statusOf({
				agents: { cline: { turnDetector: { mode: "on" } } },
				pipeline: { recovery: { mode: "on" } },
				workspaces: { local: { recovery: { enabled: false } } },
			}),
		).toEqual({
			"agents.cline.turnDetector.mode": "met",
			"pipeline.recovery.mode": "met",
			"workspaces.local.recovery.enabled": "unmet",
		});
	});

	it("shows in kanban kit show, with the settings it needs", () => {
		const resolved = resolveTeamLocal();
		const report = buildKitReport({
			kitName: "team (lemonade)",
			resolved,
			workspaceId: "local",
			selectedAgentId: "claude",
			maxFailRounds: 3,
			outageMaxMin: 360,
			config: parsePipelineConfig({}).config,
		});
		// The one refusal is a sample card built on the QA model itself: the kit requires a QA model of another
		// vendor and has none for Muse-Glimmer, so a card someone builds on Muse-Glimmer waits in Review.
		expect(report.warnings).toEqual([
			expect.stringContaining("Muse-Glimmer-30B-GGUF-Q4_K_M is from the dev card's vendor (meta)"),
		]);
		expect(report.recommendedLandingMode).toBe("qa");
		const text = formatKitReport(report).join("\n");
		expect(text).toContain(
			"New dev cards (when the creator sets no agent):\n  cline on lemonade/Qwen3.8-27B-GGUF-UD-Q4_K_XL (tier dev)",
		);
		expect(text).not.toContain("[qa.routes[");
		expect(text).toContain("Settings this kit needs (config.json; the kit never applies them):");
		expect(text).toContain('  SET     agents.cline.turnDetector.mode = "on" (now "report"):');
	});
});
