import { describe, expect, it } from "vitest";

import { kitDocumentSchema } from "../../../src/kits/kit-schema";
import { createRoutingPolicy, getModelVendor } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";

function teamPolicy(overrides: Record<string, unknown> = {}) {
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

describe("routing policy evaluator", () => {
	it("assigns the team kit's dev agent and tier model", () => {
		expect(teamPolicy().devAssignment({ workspaceId: "foo", title: "", prompt: "", role: "dev" })).toEqual({
			agentId: "cline",
			model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
			tier: "tier3",
		});
	});

	it("routes QA by the dev card's effective model, first match wins", () => {
		const policy = teamPolicy();
		const openai = policy.qaPolicy({
			dev: createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" }),
			round: 1,
			history: createCardHistory(),
		});
		expect(openai).toMatchObject({
			kind: "qa",
			agentId: "cline",
			model: { model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
			route: "qa.routes[0]",
		});
		expect(openai.kind === "qa" && openai.promptParts.rules[0]).toContain("DRIVE THE CHANGED PATH");
		const claude = policy.qaPolicy({
			dev: createEffectiveCard({ agentId: "claude", model: "us.anthropic.claude-opus-5-5" }),
			round: 1,
			history: createCardHistory(),
		});
		expect(claude).toMatchObject({ kind: "qa", agentId: "codex", model: null, route: null });
	});

	it("never QAs non-dev roles", () => {
		for (const role of ["qa", "triage", "calibration"] as const) {
			const answer = teamPolicy().qaPolicy({
				dev: createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol", role }),
				round: 1,
				history: createCardHistory(),
			});
			expect(answer.kind).toBe("none");
		}
	});

	it("skips QA for the effective agents the kit lists", () => {
		const answer = teamPolicy({ "qa.skip.effectiveAgents": ["claude"] }).qaPolicy({
			dev: createEffectiveCard({ agentId: "claude" }),
			round: 1,
			history: createCardHistory(),
		});
		expect(answer.kind).toBe("none");
	});

	it("refuses a QA route on the dev card's vendor when the kit requires a different one", () => {
		const policy = teamPolicy({
			"qa.routes": [{ devModel: "anthropic", agent: "cline", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }],
		});
		const answer = policy.qaPolicy({
			dev: createEffectiveCard({ agentId: "cline", model: "us.anthropic.claude-opus-5-5" }),
			round: 1,
			history: createCardHistory(),
		});
		expect(answer.kind).toBe("none");
		expect(answer.kind === "none" && answer.reason).toMatch(/^refused:/u);
	});

	it("reworks until the kit's rounds or the core cap run out, then escalates", () => {
		const policy = teamPolicy();
		const dev = createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" });
		const onFail = (failRounds: number[], maxFailRounds = 3, extraRounds = 0) =>
			policy.onFail({
				dev,
				cause: "fail",
				verdict: { verdict: "FAIL", round: failRounds.at(-1) ?? 1 },
				history: createCardHistory(failRounds, extraRounds),
				limits: { maxFailRounds },
			});
		expect(onFail([1]).action).toBe("rework");
		expect(onFail([1, 2]).action).toBe("rework");
		expect(onFail([1, 2, 3])).toMatchObject({ action: "escalate", to: "orchestrator", requireApproval: true });
		// The core cap wins over the kit's rounds; handback rounds add to both.
		expect(onFail([1, 2], 2).action).toBe("escalate");
		expect(onFail([1, 2, 3], 3, 1).action).toBe("rework");
	});

	it("escalates STALLED and unchanged reworks, and reworks a land conflict", () => {
		const policy = teamPolicy();
		const dev = createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" });
		const answer = (cause: "stalled" | "unchanged" | "conflict") =>
			policy.onFail({ dev, cause, verdict: null, history: createCardHistory([1]), limits: { maxFailRounds: 3 } })
				.action;
		expect(answer("stalled")).toBe("escalate");
		expect(answer("unchanged")).toBe("escalate");
		expect(answer("conflict")).toBe("rework");
	});

	it("escalates to a tier's model on the kit's dev agent", () => {
		const answer = teamPolicy({ "escalate.to": { tier: "tier2" } }).onFail({
			dev: createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" }),
			cause: "stalled",
			verdict: null,
			history: createCardHistory(),
			limits: { maxFailRounds: 3 },
		});
		expect(answer).toMatchObject({
			action: "escalate",
			to: { agentId: "cline", model: { model: "us.moonshotai.kimi-k3" } },
		});
	});

	it("answers a FAIL with a runoff when the kit asks for one", () => {
		const kit = kitDocumentSchema.parse({
			kit: 1,
			name: "race",
			onFail: { rework: "same-model", reworkRounds: 2, runoff: { models: [{ agent: "cline", model: "m1" }] } },
		});
		const answer = createRoutingPolicy(kit).onFail({
			dev: createEffectiveCard({ agentId: "cline" }),
			cause: "fail",
			verdict: null,
			history: createCardHistory([1]),
			limits: { maxFailRounds: 3 },
		});
		expect(answer).toEqual({ action: "runoff", models: [{ agentId: "cline", provider: null, model: "m1" }] });
	});

	it("hands an outage-held card to escalate.to after onOutage.afterMin (default maxMin), never onto its own model", () => {
		const fallback = { agent: "codex", model: "us.moonshotai.kimi-k3", provider: "bedrock" };
		const dev = createEffectiveCard({
			agentId: "codex",
			model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
		});
		const ask = (overrides: Record<string, unknown>, heldMin: number, card = dev) =>
			teamPolicy({ "escalate.to": fallback, "escalate.requireApproval": false, ...overrides }).onOutage({
				dev: card,
				heldMin,
				maxMin: 360,
			});

		// Without the key (the default kit's "orchestrator") an outage is waited out, as before.
		expect(ask({}, 400)).toMatchObject({ action: "hold" });
		const on = { "onOutage.then": "escalate" };
		expect(ask(on, 359)).toMatchObject({ action: "hold" });
		expect(ask(on, 360)).toEqual({
			action: "escalate",
			to: { agentId: "codex", model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } },
			requireApproval: false,
			reason: "provider outage on us.openai.gpt-6.1-sol for 360 min",
		});
		expect(ask({ ...on, "onOutage.afterMin": 30 }, 31)).toMatchObject({ action: "escalate" });
		// The fallback itself in an outage: nothing to hand over to, so it is held (and goes to the orchestrator at maxMin).
		const kimi = createEffectiveCard({
			agentId: "codex",
			model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" },
		});
		expect(ask(on, 400, kimi)).toMatchObject({ action: "hold", reason: expect.stringContaining("already runs on") });
		expect(ask({ ...on, "escalate.to": "orchestrator" }, 400)).toMatchObject({ action: "hold" });
	});
});

describe("getModelVendor", () => {
	it("reads Bedrock-style and bare model ids", () => {
		expect(getModelVendor("us.openai.gpt-6.1-sol")).toBe("openai");
		expect(getModelVendor("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
		expect(getModelVendor("qwen.qwen3-next-80b-a3b")).toBe("qwen");
		expect(getModelVendor("gpt-6.1-sol")).toBe("openai");
		expect(getModelVendor("claude-opus-5-5")).toBe("anthropic");
		expect(getModelVendor("local-model")).toBeNull();
		expect(getModelVendor(null)).toBeNull();
	});
});
