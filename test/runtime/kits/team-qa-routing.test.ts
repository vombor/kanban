import { describe, expect, it } from "vitest";

import type { QaPolicyAnswer } from "../../../src/kits/policy";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";
import { createTeamPolicy, toFooEffectiveCard } from "../../utilities/legacy-team-fixtures";

// Ported from archive/devteam-kit:test/qa-route.test.cjs@9828540 (user rule 10/06: the QA vendor differs from the dev
// vendor). OpenAI-built cards get Haiku 4.5 on Cline plus the "drive" rule; every other card gets the default QA
// agent (Codex, with its own model config). Here the answers come from the built-in `team` kit alone.
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
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
