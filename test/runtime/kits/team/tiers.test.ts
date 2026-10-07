import { describe, expect, it } from "vitest";

import { createRoutingPolicy } from "../../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../../src/kits/resolve-kit";
import { buildTiersReport, formatTiersReport } from "../../../../src/kits/team/tiers/tiers-report";
import { createCardHistory, createEffectiveCard } from "../../../utilities/effective-card";

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
	createRoutingPolicy(kit).onFail({
		dev: createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" }),
		cause: "stalled",
		verdict: null,
		history: createCardHistory([1, 2, 3]),
		limits: { maxFailRounds: 3 },
	});

describe("tiers feature", () => {
	it("escalate.to { tier: tier2 } answers a sibling on the tier's model on the kit's dev agent (tier-2 escalation)", () => {
		expect(escalateAfterStall(team({ "escalate.to": { tier: "tier2" } }))).toEqual({
			action: "escalate",
			to: { agentId: "cline", model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } },
			requireApproval: true,
			reason: "QA stalled",
		});
	});

	it("without the tiers feature a tier escalation goes to the orchestrator", () => {
		const answer = escalateAfterStall(
			team({ "escalate.to": { tier: "tier2" }, features: ["scoreboard", "bench", "runoffs"] }),
		);
		expect(answer).toMatchObject({ action: "escalate", to: "orchestrator", requireApproval: true });
		expect(answer.action === "escalate" && answer.reason).toContain('needs the "tiers" feature');
	});

	it("the team kit as shipped still escalates to the orchestrator (no automatic senior tier, §12)", () => {
		expect(escalateAfterStall(team())).toMatchObject({ action: "escalate", to: "orchestrator" });
	});

	it("kanban bench tiers: each tier's pick, default and dropped entries, and what uses a tier", () => {
		const report = buildTiersReport(team());
		expect(report.featureOn).toBe(true);
		expect(report.uses).toEqual({ devTier: "tier3", escalateTier: null });
		const tier3 = report.tiers.find((tier) => tier.name === "tier3");
		expect(tier3?.pick).toEqual({ provider: "bedrock", model: "us.openai.gpt-6.1-sol" });
		expect(tier3?.entries[0]).toMatchObject({ default: true, picked: true, dropped: false });
		const qa = report.tiers.find((tier) => tier.name === "qa");
		expect(qa?.entries.map((entry) => [entry.model, entry.dropped, entry.picked])).toEqual([
			["us.anthropic.claude-haiku-4-5-20251001-v1:0", false, true],
			["us.amazon.nova-2-lite-v1:0", true, false],
		]);
		expect(report.tiers.find((tier) => tier.name === "tier1")?.pick).toMatchObject({
			error: expect.stringContaining("no model that isn't dropped"),
		});

		const text = formatTiersReport(report).join("\n");
		expect(text).toContain("Kit team: tiers feature on");
		expect(text).toContain("tier3: picks bedrock/us.openai.gpt-6.1-sol");
		expect(text).toContain("bedrock/us.amazon.nova-2-lite-v1:0 [DROPPED]");
		expect(text).toContain("dev.model: tier tier3; escalate.to: no tier");

		const off = formatTiersReport(buildTiersReport(team({ "escalate.to": { tier: "tier2" }, features: [] }))).join(
			"\n",
		);
		expect(off).toContain("escalate.to: tier tier2 (ignored: the tiers feature is off");
	});
});
