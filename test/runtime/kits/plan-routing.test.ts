import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { buildKitReport, formatKitReport } from "../../../src/kits/kit-report";
import { kitDocumentSchema } from "../../../src/kits/kit-schema";
import { decidePlanAssignment } from "../../../src/kits/plan-assignment";
import { answerPlanAssignment, createRoutingPolicy } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";
import { PROVISIONAL_ALLOWED } from "../../utilities/routing-vetting";

function resolveBuiltIn(name: string, overrides: Record<string, unknown> = {}) {
	const kit = getBuiltInKits().get(name);
	if (!kit) {
		throw new Error(`${name} kit missing`);
	}
	const resolved = resolveKitLayers(getDefaultKit(), kit, overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved;
}

const config = parsePipelineConfig({}).config;

describe("plan routing (the kit's plan section)", () => {
	it("team: plan cards run on Claude with its own default model, starting in plan mode", () => {
		const { kit } = resolveBuiltIn("team");
		expect(answerPlanAssignment(kit, PROVISIONAL_ALLOWED)).toEqual({
			kind: "plan",
			agentId: "claude",
			startInPlanMode: true,
			rules: [],
		});
		// Room for a later runoff or calibration: candidates are listed, routing doesn't read them.
		expect(kit.plan?.candidates?.map((candidate) => candidate.agent)).toEqual(["claude"]);
		expect(kit.plan?.note).toContain("candidates");
	});

	it("default: plan is disabled, so the one agent keeps planning its own work", () => {
		expect(answerPlanAssignment(resolveBuiltIn("default").kit, PROVISIONAL_ALLOWED)).toMatchObject({
			kind: "disabled",
		});
		const decision = decidePlanAssignment({
			request: { workspaceId: "ws" },
			config,
			resolved: { ...resolveBuiltIn("default"), kitName: "default", issues: [] },
		});
		expect(decision).toMatchObject({ ok: false, kitName: "default" });
		expect(decision.ok === false && decision.error).toContain("plan.enabled");
	});

	it("every built-in kit skip QA for plan cards, and the evaluator never QAs one", () => {
		for (const name of ["default", "team", "team-local"]) {
			const { kit } = resolveBuiltIn(name);
			expect(kit.qa?.skip?.roles).toContain("plan");
			const answer = createRoutingPolicy(kit, PROVISIONAL_ALLOWED).qaPolicy({
				dev: createEffectiveCard({ agentId: "claude", role: "plan" }),
				round: 1,
				history: createCardHistory(),
			});
			expect(answer).toEqual({ kind: "none", reason: "plan cards are never QA'd" });
		}
	});

	it("applies the kit's agent, a pinned model and its provider, and lets the creator's choices win", () => {
		const resolved = {
			...resolveBuiltIn("team", {
				"plan.agent": "cline",
				"plan.model": { provider: "bedrock", model: "us.anthropic.claude-opus-5-5" },
				"plan.rules": { specs: "Specs follow docs/specs/TEMPLATE.md." },
			}),
			kitName: "team",
			issues: [],
		};
		// Claude on Opus has no plan vetting in the registry: the kit's planner is refused.
		const unvetted = {
			...resolved,
			...resolveBuiltIn("team", { "plan.model": { model: "us.anthropic.claude-opus-5-5" } }),
		};
		expect(decidePlanAssignment({ request: { workspaceId: "ws" }, config, resolved: unvetted })).toMatchObject({
			ok: false,
			error: expect.stringMatching(
				/plan role is refused: claude \+ us\.anthropic\.claude-opus-5-5 is not vetted for plan work/u,
			),
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
		const report = (name: string) =>
			formatKitReport(
				buildKitReport({
					kitName: name,
					resolved: resolveBuiltIn(name),
					workspaceId: "ws",
					selectedAgentId: "claude",
					maxFailRounds: 3,
					outageMaxMin: 360,
					config: parsePipelineConfig({}).config,
				}),
			).join("\n");
		expect(report("team")).toContain(
			"Plan cards (kanban task create --role plan):\n  claude on its own default model, starting in plan mode",
		);
		expect(report("default")).toMatch(/Plan cards[^\n]*\n {2}none \(kit "default" has plan.enabled off\)/u);
	});
});
