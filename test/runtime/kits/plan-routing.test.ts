import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { buildKitReport, formatKitReport } from "../../../src/kits/kit-report";
import { kitDocumentSchema } from "../../../src/kits/kit-schema";
import { decidePlanAssignment } from "../../../src/kits/plan-assignment";
import { answerPlanAssignment, createRoutingPolicy } from "../../../src/kits/policy";
import { getBuiltInKits, getBuiltInPresets, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";

function resolveBuiltIn(name: string, overrides: Record<string, unknown> = {}, preset: string | null = null) {
	const kit = getBuiltInKits().get(name);
	const presetDocument = preset === null ? null : (getBuiltInPresets().get(preset) ?? null);
	if (!kit || (preset !== null && !presetDocument)) {
		throw new Error(`${name} kit or preset ${preset} missing`);
	}
	const resolved = resolveKitLayers(getDefaultKit(), kit, overrides, presetDocument);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved;
}

const config = parsePipelineConfig({}).config;

describe("plan routing (the kit's plan section)", () => {
	it("team (cloud): plan cards run on Cline with Claude Opus 5.5, starting in plan mode", () => {
		const { kit } = resolveBuiltIn("team", {}, "cloud");
		expect(answerPlanAssignment(kit)).toEqual({
			kind: "plan",
			agentId: "cline",
			model: { provider: "bedrock", model: "us.anthropic.claude-opus-5-5" },
			startInPlanMode: true,
			rules: [],
		});
		// Room for a later runoff or calibration: candidates are listed, routing doesn't read them.
		expect(kit.plan?.candidates?.map((candidate) => candidate.agent)).toEqual(["cline"]);
	});

	it("team (custom): a plan card runs on the selected agent until the project sets roles.plan", () => {
		expect(answerPlanAssignment(resolveBuiltIn("team").kit)).toEqual({
			kind: "plan",
			agentId: null,
			startInPlanMode: true,
			rules: [],
		});
	});

	it("default: plan is disabled, so the one agent keeps planning its own work", () => {
		expect(answerPlanAssignment(resolveBuiltIn("default").kit)).toMatchObject({
			kind: "disabled",
		});
		const decision = decidePlanAssignment({
			request: { workspaceId: "ws" },
			config,
			resolved: { ...resolveBuiltIn("default"), kitLabel: "default", issues: [] },
		});
		expect(decision).toMatchObject({ ok: false, kitName: "default" });
		expect(decision.ok === false && decision.error).toContain("plan.enabled");
	});

	it("every built-in kit skip QA for plan cards, and the evaluator never QAs one", () => {
		for (const [name, preset] of [
			["default", null],
			["team", null],
			["team", "cloud"],
			["team", "lemonade"],
			["team", "cline"],
		] as const) {
			const { kit } = resolveBuiltIn(name, {}, preset);
			expect(kit.qa?.skip?.roles).toContain("plan");
			const answer = createRoutingPolicy(kit).qaPolicy({
				dev: createEffectiveCard({ agentId: "claude", role: "plan" }),
				round: 1,
				history: createCardHistory(),
			});
			expect(answer).toEqual({ kind: "none", reason: "plan cards are never QA'd" });
		}
	});

	it("applies the kit's agent, a pinned model and its provider, and lets the creator's choices win", () => {
		const resolved = {
			...resolveBuiltIn(
				"team",
				{
					"plan.agent": "cline",
					"plan.model": { provider: "bedrock", model: "us.anthropic.claude-opus-5-5" },
					"plan.rules": { specs: "Specs follow docs/specs/TEMPLATE.md." },
				},
				"cloud",
			),
			kitLabel: "team (cloud)",
			issues: [],
		};
		// Any model may plan: Claude on Opus is applied as the kit says.
		const claudeOpus = {
			...resolved,
			...resolveBuiltIn(
				"team",
				{ "plan.agent": "claude", "plan.model": { model: "us.anthropic.claude-opus-5-5" } },
				"cloud",
			),
		};
		expect(decidePlanAssignment({ request: { workspaceId: "ws" }, config, resolved: claudeOpus })).toMatchObject({
			ok: true,
			outcome: "applied",
			agentSettings: { modelId: "us.anthropic.claude-opus-5-5" },
		});
		expect(decidePlanAssignment({ request: { workspaceId: "ws" }, config, resolved })).toMatchObject({
			ok: true,
			outcome: "applied",
			agentId: "cline",
			agentSettings: { modelId: "us.anthropic.claude-opus-5-5" },
			startInPlanMode: true,
			rules: ["Specs follow docs/specs/TEMPLATE.md."],
		});
		expect(
			decidePlanAssignment({
				request: { workspaceId: "ws", agentId: "codex", startInPlanMode: false },
				config,
				resolved,
			}),
		).toMatchObject({
			ok: true,
			outcome: "explicit",
			agentId: "codex",
			agentSettings: undefined,
			startInPlanMode: false,
		});
	});

	it("validates the plan section and role: strict keys, roles.plan.model needs an agent, tier references", () => {
		const base = { kit: 1, name: "x" };
		expect(
			kitDocumentSchema.safeParse({ ...base, plan: { enabled: true }, roles: { plan: { agent: "claude" } } })
				.success,
		).toBe(true);
		expect(kitDocumentSchema.safeParse({ ...base, plan: { enabled: true, routes: [] } }).success).toBe(false);
		expect(kitDocumentSchema.safeParse({ ...base, roles: { plan: { model: "m" } } }).success).toBe(false);
		expect(
			kitDocumentSchema.safeParse({ ...base, roles: { plan: { agent: "claude", tier: "missing" } } }).success,
		).toBe(false);
		expect(
			kitDocumentSchema.safeParse({
				...base,
				plan: { candidates: [{ agent: "codex" }, { agent: "copilot", model: { model: "gpt-6.1" } }] },
			}).success,
		).toBe(true);
	});

	it("kanban kit show prints the plan answer", () => {
		const report = (name: string, preset: string | null = null) =>
			formatKitReport(
				buildKitReport({
					kitName: name,
					resolved: resolveBuiltIn(name, {}, preset),
					workspaceId: "ws",
					selectedAgentId: "claude",
					maxFailRounds: 3,
					outageMaxMin: 360,
					config: parsePipelineConfig({}).config,
				}),
			).join("\n");
		expect(report("team", "cloud")).toContain(
			"Plan cards (kanban task create --role plan):\n  cline on bedrock/us.anthropic.claude-opus-5-5, starting in plan mode",
		);
		expect(report("default")).toMatch(/Plan cards[^\n]*\n {2}none \(kit "default" has plan.enabled off\)/u);
	});
});
