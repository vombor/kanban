import { describe, expect, it } from "vitest";

import { createRoutingPolicy } from "../../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../../src/kits/resolve-kit";
import { buildTiersReport, formatTiersReport } from "../../../../src/kits/team/tiers/tiers-report";
import { createCardHistory, createEffectiveCard } from "../../../utilities/effective-card";
import { PROVISIONAL_ALLOWED } from "../../../utilities/routing-vetting";

function team(overrides: Record<string, unknown> = {}) {
	const kit = getBuiltInKits().get("team");
	if (!kit) {
		throw new Error("team kit missing");
	}
	const resolved = resolveKitLayers(getDefaultKit(), kit, overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved.kit;
}

const escalateAfterStall = (kit: ReturnType<typeof team>) =>
	createRoutingPolicy(kit, PROVISIONAL_ALLOWED).onFail({
		dev: createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" }),
		cause: "stalled",
		verdict: null,
		history: createCardHistory([1, 2, 3]),
		limits: { maxFailRounds: 3 },
	});

describe("tiers feature", () => {
	it("the team kit's fallback role { tier: tier2 } answers a sibling on the tier's model on the dev role's agent, no approval", () => {
		expect(escalateAfterStall(team())).toEqual({
			action: "escalate",
			to: { agentId: "cline", model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } },
			requireApproval: false,
			reason: "QA stalled",
		});
	});

	it("the legacy escalate.to { tier } and escalate.requireApproval still mean the fallback role and its approval", () => {
		expect(
			escalateAfterStall(team({ "escalate.to": { tier: "tier2" }, "escalate.requireApproval": true })),
		).toMatchObject({
			action: "escalate",
			to: { agentId: "cline", model: { model: "us.moonshotai.kimi-k3" } },
			requireApproval: true,
		});
	});

	it("without the tiers feature a tier fallback goes to the orchestrator", () => {
		const answer = escalateAfterStall(team({ features: ["scoreboard", "bench", "runoffs"] }));
		expect(answer).toMatchObject({ action: "escalate", to: "orchestrator", requireApproval: false });
		expect(answer.action === "escalate" && answer.reason).toContain('needs the "tiers" feature');
	});

	it("a trigger that is off (or the legacy escalate.to orchestrator) goes to the orchestrator", () => {
		expect(escalateAfterStall(team({ "fallback.on.qaStalled": false }))).toMatchObject({ to: "orchestrator" });
		expect(escalateAfterStall(team({ "escalate.to": "orchestrator" }))).toMatchObject({ to: "orchestrator" });
	});

	it("kanban bench tiers: each tier's pick, default and dropped entries, and what uses a tier", () => {
		const report = buildTiersReport(team());
		expect(report.featureOn).toBe(true);
		expect(report.uses).toEqual({ devTier: "tier3", escalateTier: "tier2" });
		const tier3 = report.tiers.find((tier) => tier.name === "tier3");
		expect(tier3?.pick).toEqual({ provider: "bedrock", model: "us.openai.gpt-6.1-sol" });
		// A candidate after the default is listed, not dropped, and not picked (Nova 2 Lite, back 2026-10-07).
		expect(tier3?.entries.map((entry) => [entry.model, entry.default, entry.dropped, entry.picked])).toEqual([
			["us.openai.gpt-6.1-sol", true, false, true],
			["us.amazon.nova-2-lite-v1:0", false, false, false],
		]);
		const qa = report.tiers.find((tier) => tier.name === "qa");
		expect(qa?.entries.map((entry) => [entry.model, entry.dropped, entry.picked])).toEqual([
			["us.anthropic.claude-haiku-4-5-20251001-v1:0", false, true],
			["us.amazon.nova-2-lite-v1:0", false, false],
		]);
		expect(report.dropped.map((entry) => entry.model)).not.toContain("us.amazon.nova-2-lite-v1:0");
		expect(report.tiers.find((tier) => tier.name === "tier1")?.pick).toMatchObject({
			error: expect.stringContaining("no model that isn't dropped"),
		});

		const text = formatTiersReport(report).join("\n");
		expect(text).toContain("Kit team: tiers feature on");
		expect(text).toContain("tier3: picks bedrock/us.openai.gpt-6.1-sol");
		expect(text).toContain("  - bedrock/us.amazon.nova-2-lite-v1:0: candidate; dropped 2026-10-05");
		expect(text).not.toContain("[DROPPED]");
		expect(text).toContain("Dropped (skipped on every provider):");
		expect(text).toContain("roles.dev: tier tier3; roles.fallback: tier tier2");

		const off = formatTiersReport(buildTiersReport(team({ features: [] }))).join("\n");
		expect(off).toContain("roles.fallback: tier tier2 (ignored: the tiers feature is off");
	});
});
