import { describe, expect, it } from "vitest";

import { getModelVendor, type QaPolicyAnswer } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";
import { createTeamPolicy, toFooEffectiveCard } from "../../utilities/legacy-team-fixtures";

// Ported from archive/devteam-kit:test/qa-route.test.cjs@9828540 (user rule 10/06: the QA vendor differs from the dev
// vendor). OpenAI-built cards get Haiku 5.5 on Cline (4.5 until 2026-10-12) plus the "drive" rule; every other card gets the default QA
// agent (Codex, with its own model config). Here the answers come from the built-in `team-cloud` kit alone.
const HAIKU = "us.anthropic.claude-haiku-5-5";
const haiku = { kind: "qa", agentId: "cline", model: { provider: "bedrock", model: HAIKU }, route: "qa.routes[0]" };
const codex = { kind: "qa", agentId: "codex", model: null, route: null };

function ask(model: string | null, agentId: "cline" | "codex" | "claude" = "cline"): QaPolicyAnswer {
	return createTeamPolicy().qaPolicy({
		dev: createEffectiveCard({ agentId, model }),
		round: 1,
		history: createCardHistory(),
	});
}

function ruleNames(answer: QaPolicyAnswer): string[] {
	return answer.kind === "qa" ? answer.promptParts.rules.map((rule) => rule.slice(0, 22)) : [];
}

describe("team kit QA routing", () => {
	it("names Haiku 5.5 wherever it named Haiku 4.5, and no route QAs a card from its own vendor", () => {
		const team = getBuiltInKits().get("team-cloud");
		const resolved = team ? resolveKitLayers(getDefaultKit(), team, {}) : null;
		if (!resolved?.ok) {
			throw new Error("team-cloud does not resolve");
		}
		const { kit } = resolved;
		expect(JSON.stringify(kit)).not.toMatch(/haiku-4-5/u);
		expect(kit.qa?.routes?.map((route) => route.model)).toEqual([HAIKU]);
		expect(kit.tiers?.qa?.map((entry) => entry.model)).toContain(HAIKU);
		expect(kit.qa?.requireDifferentVendor).toBe(true);
		expect(getModelVendor(HAIKU)).toBe("anthropic");
		for (const route of kit.qa?.routes ?? []) {
			// The route's own devModel pattern must not match a model of the QA model's vendor.
			const devModel = new RegExp(route.devModel, "u");
			for (const model of ["us.anthropic.claude-opus-5-5", HAIKU, "claude-sonnet-5-5"]) {
				expect(devModel.test(model), `${route.devModel} vs ${model}`).toBe(false);
			}
		}
	});

	it("sends OpenAI-built cards to Haiku on Cline with the drive rule", () => {
		for (const model of [
			"us.openai.gpt-6.1-sol",
			"us.openai.gpt-6-luna",
			"gpt-6.1-sol",
			"gpt-6-luna",
			"openai.gpt-oss-120b-1:0",
		]) {
			const answer = ask(model);
			expect(answer, model).toMatchObject(haiku);
			expect(ruleNames(answer), model).toEqual(["DRIVE THE CHANGED PATH"]);
		}
	});

	it("sends every other card to Codex with no extra rules", () => {
		for (const model of ["us.anthropic.claude-opus-5-5", "us.moonshotai.kimi-k3", "us.amazon.nova-2-lite-v1:0"]) {
			const answer = ask(model);
			expect(answer, model).toMatchObject(codex);
			expect(ruleNames(answer), model).toEqual([]);
		}
		expect(ask(null, "codex"), "unknown model on a non-Cline card").toMatchObject(codex);
	});

	it("routes a Cline card with no model of its own by the Cline CLI default model", () => {
		// The fixture providers.json's lastUsedProvider model is us.openai.gpt-6.1-sol.
		const dev = toFooEffectiveCard({ id: "d0008", agentId: "cline" });
		expect(dev.model).toEqual({ provider: "bedrock", model: "us.openai.gpt-6.1-sol" });
		expect(createTeamPolicy().qaPolicy({ dev, round: 1, history: createCardHistory() })).toMatchObject(haiku);
	});

	it("routes an unpinned card on the selected agent, never as a Cline card", () => {
		// 2026-10-06 incident: a card with no agentId ran on the selected agent (Claude), not on Cline.
		const dev = toFooEffectiveCard({ id: "d0010" });
		expect(dev.agentId).toBe("claude");
		expect(dev.model).toBeNull();
		expect(createTeamPolicy().qaPolicy({ dev, round: 1, history: createCardHistory() })).toMatchObject(codex);
	});

	it("refuses a route whose QA model is from the dev card's vendor", () => {
		const policy = createTeamPolicy({
			"qa.routes": [{ devModel: "anthropic", agent: "cline", provider: "bedrock", model: HAIKU, rules: ["drive"] }],
		});
		const answer = policy.qaPolicy({
			dev: createEffectiveCard({ agentId: "cline", model: "us.anthropic.claude-opus-5-5" }),
			round: 1,
			history: createCardHistory(),
		});
		expect(answer.kind).toBe("none");
		expect(answer.kind === "none" && answer.reason).toContain("vendor (anthropic)");
		// The same route with the vendor rule off is taken.
		const relaxed = createTeamPolicy({
			"qa.requireDifferentVendor": false,
			"qa.routes": [{ devModel: "anthropic", agent: "cline", provider: "bedrock", model: HAIKU }],
		});
		expect(
			relaxed.qaPolicy({
				dev: createEffectiveCard({ agentId: "cline", model: "us.anthropic.claude-opus-5-5" }),
				round: 1,
				history: createCardHistory(),
			}),
		).toMatchObject({ kind: "qa", agentId: "cline", route: "qa.routes[0]" });
	});
});
