import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { evaluateKitRecommendedSettings } from "../../../src/kits/kit-recommendations";
import { buildKitReport, formatKitReport } from "../../../src/kits/kit-report";
import { listKitRoutes } from "../../../src/kits/kit-routes";
import { kitPresetSchema } from "../../../src/kits/kit-schema";
import { answerPlanAssignment, createRoutingPolicy, getModelVendor } from "../../../src/kits/policy";
import { getBuiltInKits, getBuiltInPresets, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { listKitModels } from "../../../src/kits/team/bench/price-sync-job";
import { isLocalProvider, isUnmeteredProvider } from "../../../src/kits/team/bench/prices";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";

const GLM = { provider: "cline-pass", model: "cline-pass/glm-5.3" };
const QWEN = { provider: "cline-pass", model: "cline-pass/qwen3.8-max" };
const KIMI = { provider: "cline-pass", model: "cline-pass/kimi-k3" };
const MINIMAX = { provider: "cline-pass", model: "cline-pass/minimax-m3" };

/** The team kit with the cline preset (what team-cline was until 2026-10-12). */
function resolveTeamCline(overrides: Record<string, unknown> = {}) {
	const kit = getBuiltInKits().get("team");
	const preset = getBuiltInPresets().get("cline");
	if (!kit || !preset) {
		throw new Error("team kit or cline preset missing");
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

describe("the team kit's cline preset", () => {
	it("validates against the preset schema", () => {
		const raw = JSON.parse(readFileSync(join(__dirname, "../../../kits/presets/cline.json"), "utf8"));
		expect(kitPresetSchema.safeParse(raw).success).toBe(true);
	});

	it("routes its four roles to its ClinePass models with no overrides, as a fresh kit apply team --preset cline does", () => {
		const { kit } = resolveTeamCline();
		expect(listKitRoutes(kit).map(({ label, combination }) => [label, combination])).toEqual([
			["roles.dev", { agentId: "cline", ...GLM }],
			["roles.qa", { agentId: "cline", ...QWEN }],
			["roles.plan", { agentId: "cline", ...MINIMAX }],
			["roles.fallback", { agentId: "cline", ...KIMI }],
		]);
	});

	it("runs everything on Cline with provider cline-pass, with the team kit's features", () => {
		const { kit } = resolveTeamCline();
		expect(collectModelProviders(kit).filter(({ provider }) => provider !== "cline-pass")).toEqual([]);
		expect(collectModelProviders(kit).every(({ model }) => model.startsWith("cline-pass/"))).toBe(true);
		expect(kit.roles?.fallback?.agent).toBeUndefined();
		expect(new Set([kit.roles?.dev?.agent, kit.roles?.qa?.agent, kit.roles?.plan?.agent])).toEqual(
			new Set(["cline"]),
		);
		expect(kit.features).toEqual(["scoreboard", "bench", "runoffs", "calibration", "tiers"]);
		expect(listKitModels(kit)).toEqual([]);
	});

	it("is a cloud provider for QA slots, unmetered for prices", () => {
		expect(isLocalProvider("cline-pass")).toBe(false);
		expect(isUnmeteredProvider("cline-pass")).toBe(true);
	});

	it("reads the vendors after the cline-pass/ prefix, all different", () => {
		expect(getModelVendor(GLM.model)).toBe("zai");
		expect(getModelVendor(QWEN.model)).toBe("qwen");
		expect(getModelVendor(KIMI.model)).toBe("moonshotai");
		expect(getModelVendor(MINIMAX.model)).toBe("minimax");
	});

	it("assigns new dev cards to glm-5.3 and plan cards to minimax-m3", () => {
		const { kit } = resolveTeamCline();
		expect(createRoutingPolicy(kit).devAssignment({ workspaceId: "ws", title: "", prompt: "", role: "dev" })).toEqual(
			{ agentId: "cline", model: GLM, tier: "dev" },
		);
		expect(answerPlanAssignment(kit)).toMatchObject({
			kind: "plan",
			agentId: "cline",
			model: MINIMAX,
			startInPlanMode: true,
		});
	});

	it("gives the dev and fallback models QA by qwen3.8-max, and refuses QA by the dev model's own vendor", () => {
		const { kit } = resolveTeamCline();
		expect(kit.qa?.requireDifferentVendor).toBe(true);
		const policy = createRoutingPolicy(kit);
		const qaFor = (model: { provider: string; model: string }) =>
			policy.qaPolicy({
				dev: createEffectiveCard({ agentId: "cline", model }),
				round: 1,
				history: createCardHistory(),
			});
		expect(qaFor(GLM)).toMatchObject({ kind: "qa", agentId: "cline", model: QWEN, route: null });
		expect(qaFor(KIMI)).toMatchObject({ kind: "qa", agentId: "cline", model: QWEN, route: null });
		expect(qaFor(QWEN)).toMatchObject({ kind: "none", reason: expect.stringContaining("(qwen)") });
	});

	it("reworks on the same model, then hands the task to kimi-k3 at once, outages included", () => {
		const policy = createRoutingPolicy(resolveTeamCline().kit);
		const dev = createEffectiveCard({ agentId: "cline", model: GLM });
		const limits = { maxFailRounds: 3 };
		expect(policy.onFail({ dev, cause: "fail", verdict: null, history: createCardHistory([1]), limits })).toEqual({
			action: "rework",
			clearContext: "auto",
		});
		expect(
			policy.onFail({ dev, cause: "fail", verdict: null, history: createCardHistory([1, 2, 3]), limits }),
		).toMatchObject({ action: "escalate", to: { agentId: "cline", model: KIMI }, requireApproval: false });
		// One workflow for every team: after maxMin the fallback takes over (it then waits on the same subscription's
		// outage and goes to the orchestrator, since a fallback sibling never falls back again).
		expect(policy.onOutage({ dev, heldMin: 400, maxMin: 360 })).toMatchObject({
			action: "escalate",
			to: { agentId: "cline", model: KIMI },
			requireApproval: false,
		});
	});

	it("names the recovery settings it needs and shows in kanban kit show", () => {
		const resolved = resolveTeamCline();
		const statuses = evaluateKitRecommendedSettings(resolved.kit, parsePipelineConfig({}).config, "cp").map(
			(entry) => [entry.configKey, entry.status],
		);
		expect(Object.fromEntries(statuses)).toEqual({
			"pipeline.recovery.mode": "unmet",
			"workspaces.cp.recovery.enabled": "met",
		});
		const report = buildKitReport({
			kitName: "team (cline)",
			resolved,
			workspaceId: "cp",
			selectedAgentId: "claude",
			maxFailRounds: 3,
			outageMaxMin: 360,
			config: parsePipelineConfig({}).config,
		});
		// The one refusal is a sample card built on the QA model itself: no QA model of another vendor for qwen.
		expect(report.warnings).toEqual([
			expect.stringContaining("cline-pass/qwen3.8-max is from the dev card's vendor (qwen)"),
		]);
		expect(report.recommendedLandingMode).toBe("qa");
		const text = formatKitReport(report).join("\n");
		expect(text).toContain(
			"New dev cards (when the creator sets no agent):\n  cline on cline-pass/cline-pass/glm-5.3 (tier dev)",
		);
	});
});
