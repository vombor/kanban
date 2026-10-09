import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { evaluateKitRecommendedSettings } from "../../../src/kits/kit-recommendations";
import { buildKitReport, formatKitReport } from "../../../src/kits/kit-report";
import { answerPlanAssignment, createRoutingPolicy } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { listKitModels } from "../../../src/kits/team/bench/price-sync-job";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";

const GLM = { provider: "lemonade", model: "GLM-4.7-Flash-GGUF" };
const DEVSTRAL = { provider: "lemonade", model: "Devstral-Small-2507-GGUF" };
const QWEN = { provider: "lemonade", model: "Qwen3.6-35B-A3B-MTP-GGUF" };

function resolveTeamLocal(overrides: Record<string, unknown> = {}) {
	const kit = getBuiltInKits().get("team-local");
	if (!kit) {
		throw new Error("team-local kit missing");
	}
	const resolved = resolveKitLayers(getDefaultKit(), kit, overrides);
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

describe("team-local kit", () => {
	it("routes nothing to a paid provider: every model is on lemonade, every agent is cline", () => {
		const { kit } = resolveTeamLocal();
		const models = collectModelProviders(kit);
		expect(models.length).toBeGreaterThan(5);
		expect(models.filter(({ provider }) => provider !== "lemonade")).toEqual([]);
		const agents = [
			kit.dev?.agent,
			kit.qa?.default?.agent,
			kit.plan?.agent,
			...(kit.qa?.routes ?? []).map((r) => r.agent),
		];
		expect(new Set(agents)).toEqual(new Set(["cline"]));
		expect(kit.features).toEqual(["scoreboard", "bench", "calibration", "tiers"]);
		expect(kit.prices?.autoSync).toBe(false);
	});

	it("assigns new dev and plan cards to Cline on the dev tier's local model", () => {
		const { kit } = resolveTeamLocal();
		expect(createRoutingPolicy(kit).devAssignment({ workspaceId: "ws", title: "", prompt: "", role: "dev" })).toEqual(
			{
				agentId: "cline",
				model: GLM,
				tier: "dev",
			},
		);
		expect(answerPlanAssignment(kit)).toEqual({
			kind: "plan",
			agentId: "cline",
			model: GLM,
			tier: "dev",
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
		expect(qaFor(GLM)).toMatchObject({ kind: "qa", agentId: "cline", model: DEVSTRAL, route: null });
		expect(qaFor(QWEN)).toMatchObject({ kind: "qa", model: DEVSTRAL });
		expect(qaFor(DEVSTRAL)).toMatchObject({ kind: "qa", model: GLM, route: "qa.routes[0]" });
		expect(qaFor({ provider: "lemonade", model: "DeepSeek-V4-Flash-0731-GGUF-BF16" })).toMatchObject({
			kind: "qa",
			model: DEVSTRAL,
		});
	});

	it("refuses QA by the dev model's own family", () => {
		const policy = createRoutingPolicy(resolveTeamLocal({ "qa.routes": [] }).kit);
		expect(
			policy.qaPolicy({
				dev: createEffectiveCard({ agentId: "cline", model: DEVSTRAL }),
				round: 1,
				history: createCardHistory(),
			}),
		).toMatchObject({ kind: "none", reason: expect.stringContaining("(mistral)") });
	});

	it("reworks on the same model, then hands the task to the fallback local model at once, and waits out Lemonade outages", () => {
		const policy = createRoutingPolicy(resolveTeamLocal().kit);
		const dev = createEffectiveCard({ agentId: "cline", model: GLM });
		const limits = { maxFailRounds: 3 };
		expect(policy.onFail({ dev, cause: "fail", verdict: null, history: createCardHistory([1]), limits })).toEqual({
			action: "rework",
			clearContext: "auto",
		});
		expect(
			policy.onFail({ dev, cause: "fail", verdict: null, history: createCardHistory([1, 2, 3]), limits }),
		).toMatchObject({ action: "escalate", to: { agentId: "cline", model: QWEN }, requireApproval: false });
		expect(policy.onOutage({ dev, heldMin: 400, maxMin: 360 })).toMatchObject({ action: "hold" });
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

	it("shows in kanban kit show without refused QA routes, with the settings it needs", () => {
		const resolved = resolveTeamLocal();
		const report = buildKitReport({
			kitName: "team-local",
			resolved,
			workspaceId: "local",
			selectedAgentId: "claude",
			maxFailRounds: 3,
			outageMaxMin: 360,
			config: parsePipelineConfig({}).config,
		});
		expect(report.warnings).toEqual([]);
		expect(report.recommendedLandingMode).toBe("qa");
		const text = formatKitReport(report).join("\n");
		expect(text).toContain(
			"New dev cards (when the creator sets no agent):\n  cline on lemonade/GLM-4.7-Flash-GGUF (tier dev)",
		);
		expect(text).toContain("cline on Devstral-Small-2507-GGUF: cline on lemonade/GLM-4.7-Flash-GGUF [qa.routes[0]]");
		expect(text).toContain("Settings this kit needs (config.json; the kit never applies them):");
		expect(text).toContain('  SET     agents.cline.turnDetector.mode = "on" (now "report"):');
	});
});
