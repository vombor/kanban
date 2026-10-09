import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { decideCardRouting, listAllowedCombinations } from "../../../src/kits/card-routing-check";
import { decideDevAssignment } from "../../../src/kits/dev-assignment";
import { answerPlanAssignment, createRoutingPolicy } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";
import {
	checkKitRoutes,
	checkRouting,
	getStrictRoutingVetting,
	getWorkspaceRoutingVetting,
	listKitRoutes,
} from "../../../src/kits/routing-vetting";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";
import { PROVISIONAL_ALLOWED } from "../../utilities/routing-vetting";

// foo's project settings (10/09): sol on Codex builds, kimi on Codex takes over, Haiku 5.5 on Cline reviews, Opus 5.5
// on Cline plans.
const FOO = {
	"roles.dev.agent": "codex",
	"roles.dev.model": "us.openai.gpt-6.1-sol",
	"roles.dev.provider": "bedrock",
	"roles.fallback.agent": "codex",
	"roles.fallback.model": "us.moonshotai.kimi-k3",
	"roles.qa.agent": "cline",
	"roles.qa.provider": "bedrock",
	"roles.qa.model": "us.anthropic.claude-haiku-5-5",
	"roles.plan.agent": "cline",
	"roles.plan.provider": "bedrock",
	"roles.plan.model": "us.anthropic.claude-opus-5-5",
};

function resolveTeam(overrides: Record<string, unknown> = {}) {
	const kit = getBuiltInKits().get("team");
	if (!kit) {
		throw new Error("no team kit");
	}
	const resolved = resolveKitLayers(getDefaultKit(), kit, overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved.kit;
}

const strict = getStrictRoutingVetting();
const dev = createEffectiveCard({ agentId: "codex", model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" } });

describe("checkRouting", () => {
	it("allows vetted, refuses rejected and unknown with the reason and the vet command, provisional per workspace", () => {
		expect(
			checkRouting(strict, "qa", { agentId: "cline", provider: "bedrock", model: "us.anthropic.claude-haiku-5-5" })
				.ok,
		).toBe(true);
		const unknown = checkRouting(strict, "dev", { agentId: "copilot", provider: null, model: "gpt-9" });
		expect(unknown).toMatchObject({
			ok: false,
			vetCommand: "kanban models vet --agent copilot --model gpt-9 --role dev",
		});
		expect(!unknown.ok && unknown.message).toMatch(/not vetted for dev work .*kanban models vet --agent copilot/u);
		const rejected = checkRouting(strict, "dev", {
			agentId: "cline",
			provider: "bedrock",
			model: "qwen.qwen3-next-80b-a3b",
		});
		expect(!rejected.ok && rejected.message).toMatch(/rejected for dev work .*broke large TSX files/u);
		const glm = { agentId: "cline" as const, provider: "lemonade", model: "GLM-4.7-Flash-GGUF" };
		expect(checkRouting(strict, "dev", glm).ok).toBe(false);
		expect(checkRouting(PROVISIONAL_ALLOWED, "dev", glm).ok).toBe(true);
		const config = parsePipelineConfig({ workspaces: { local: { models: { allowProvisional: true } } } }).config;
		expect(getWorkspaceRoutingVetting(config, "local").allowProvisional).toBe(true);
		expect(getWorkspaceRoutingVetting(config, "other").allowProvisional).toBe(false);
	});

	it("lists every route of foo's kit as allowed, and the plain team kit's provisional defaults as refused", () => {
		const foo = checkKitRoutes(resolveTeam(FOO), strict);
		expect(foo.map((route) => [route.label, route.role, route.check.ok])).toEqual([
			["roles.dev", "dev", true],
			["roles.qa", "qa", true],
			["qa.routes[0]", "qa", true],
			["roles.plan", "plan", true],
			["roles.fallback", "dev", true],
		]);
		const team = checkKitRoutes(resolveTeam(), strict);
		expect(team.filter((route) => !route.check.ok).map((route) => route.label)).toEqual([
			"roles.dev",
			"roles.qa",
			"roles.plan",
			"roles.fallback",
		]);
		// The default kit routes nothing.
		expect(listKitRoutes(getDefaultKit())).toEqual([]);
	});
});

describe("the routing policy refuses what the registry doesn't allow", () => {
	it("devAssignment: a refused kit dev role is never applied", () => {
		const kit = resolveTeam({ ...FOO, "roles.dev.model": "gpt-unknown", "roles.dev.provider": null });
		expect(
			createRoutingPolicy(kit, strict).devAssignment({ workspaceId: "w", title: "", prompt: "", role: "dev" }),
		).toMatchObject({
			agentId: "codex",
			refused: expect.stringContaining("codex + gpt-unknown is not vetted for dev work"),
		});
		const config = parsePipelineConfig({ workspaces: { w: { kit: { name: "team" } } } }).config;
		const decision = decideDevAssignment({
			request: { workspaceId: "w", title: "t", prompt: "p" },
			config,
			resolved: {
				workspaceId: "w",
				requestedKitName: "team",
				kitName: "team",
				overrides: {},
				issues: [],
				kit,
				sources: {},
			},
		});
		expect(decision).toMatchObject({ outcome: "refused", agentId: undefined, agentSettings: undefined });
		// The creator's own choice still wins (the CLI checks it: card-routing-check.ts).
		expect(
			decideDevAssignment({
				request: { workspaceId: "w", title: "t", prompt: "p", agentId: "codex" },
				config,
				resolved: {
					workspaceId: "w",
					requestedKitName: "team",
					kitName: "team",
					overrides: {},
					issues: [],
					kit,
					sources: {},
				},
			}).outcome,
		).toBe("explicit");
	});

	it("the QA gate: an unvetted QA model is no QA (the card waits in Review with the reason), never a land", () => {
		const kit = resolveTeam({
			...FOO,
			"qa.routes": [],
			"roles.qa.model": "us.anthropic.claude-haiku-5-5",
			"roles.qa.provider": "lemonade",
		});
		const answer = createRoutingPolicy(kit, strict).qaPolicy({ dev, round: 1, history: createCardHistory() });
		expect(answer).toMatchObject({
			kind: "none",
			reason: expect.stringMatching(
				/^refused: roles\.qa: cline \+ lemonade \+ us\.anthropic\.claude-haiku-5-5 is not vetted for qa/u,
			),
		});
		expect(
			createRoutingPolicy(resolveTeam(FOO), strict).qaPolicy({ dev, round: 1, history: createCardHistory() }),
		).toMatchObject({
			kind: "qa",
			agentId: "cline",
		});
	});

	it("escalation and outage takeover: an unvetted fallback goes to the orchestrator / keeps holding", () => {
		const kit = resolveTeam({ ...FOO, "roles.fallback.model": "kimi-unknown" });
		const policy = createRoutingPolicy(kit, strict);
		expect(
			policy.onFail({
				dev,
				cause: "fail",
				verdict: null,
				history: createCardHistory([1, 2, 3]),
				limits: { maxFailRounds: 3 },
			}),
		).toMatchObject({
			action: "escalate",
			to: "orchestrator",
			reason: expect.stringContaining("the fallback is refused: codex + kimi-unknown is not vetted for dev work"),
		});
		expect(policy.onOutage({ dev, heldMin: 400, maxMin: 360 })).toMatchObject({ action: "hold" });
		expect(
			createRoutingPolicy(resolveTeam(FOO), strict).onFail({
				dev,
				cause: "fail",
				verdict: null,
				history: createCardHistory([1, 2, 3]),
				limits: { maxFailRounds: 3 },
			}),
		).toMatchObject({ action: "escalate", to: { agentId: "codex", model: { model: "us.moonshotai.kimi-k3" } } });
	});

	it("plans: a refused planner is marked refused", () => {
		expect(answerPlanAssignment(resolveTeam(), strict)).toMatchObject({
			kind: "plan",
			agentId: "claude",
			refused: expect.stringContaining("claude + its own default model is only provisional for plan work"),
		});
		expect(answerPlanAssignment(resolveTeam(FOO), strict)).not.toHaveProperty("refused");
	});
});

describe("a card's explicit agent and model", () => {
	const config = parsePipelineConfig({ workspaces: { foo: { kit: { name: "team" } } } }).config;
	const base = {
		config,
		kitName: "team",
		workspaceId: "foo",
		role: "dev" as const,
		agentId: "copilot" as const,
		agentSettings: { modelId: "gpt-9" },
		selectedAgentId: "claude" as const,
	};

	it("refuses an agent session's unvetted choice, warns the user, and checks nothing where Kanban routes nothing", () => {
		expect(decideCardRouting({ ...base, fromAgentSession: true })).toMatchObject({
			kind: "refuse",
			message: expect.stringContaining("foo routes only to combinations the vetted model registry allows"),
		});
		expect(decideCardRouting({ ...base, fromAgentSession: false })).toMatchObject({
			kind: "warn",
			message: expect.stringContaining("your call"),
		});
		expect(
			decideCardRouting({
				...base,
				agentId: "codex",
				agentSettings: { modelId: "us.openai.gpt-6.1-sol" },
				fromAgentSession: true,
			}),
		).toEqual({ kind: "ok" });
		// No agent: the selected agent, here Claude on its own default model, provisional for plans only.
		expect(
			decideCardRouting({ ...base, role: "plan", agentId: null, agentSettings: undefined, fromAgentSession: true })
				.kind,
		).toBe("refuse");
		expect(decideCardRouting({ ...base, kitName: "default", fromAgentSession: true })).toEqual({ kind: "none" });
		// Kanban's own runners' cards (calibration, models vet) check their models themselves.
		expect(decideCardRouting({ ...base, role: "calibration", fromAgentSession: true })).toEqual({ kind: "none" });
	});

	it("lists what the create dialog may preselect without a warning", () => {
		const allowed = listAllowedCombinations(config, "foo", "team", "dev") ?? [];
		expect(allowed.every((entry) => entry.status === "vetted")).toBe(true);
		expect(allowed.map((entry) => entry.modelId)).toEqual(
			expect.arrayContaining(["us.openai.gpt-6.1-sol", "us.moonshotai.kimi-k3"]),
		);
		expect(listAllowedCombinations(config, "foo", "default", "dev")).toBeNull();
	});
});
