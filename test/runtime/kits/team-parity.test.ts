import { describe, expect, it } from "vitest";

import type { FailCause, OnFailAnswer } from "../../../src/kits/policy";
import { createCardHistory } from "../../utilities/effective-card";
import {
	createTeamPolicy,
	getFooImportedOverrides,
	type LegacyCard,
	readLegacyKitConfig,
	readLegacyQaRoutes,
	toFooEffectiveCard,
} from "../../utilities/legacy-team-fixtures";

// The `team` kit plus foo's overrides from `kanban config import-kit` must answer like the legacy kit did for foo with
// the live kit.config.json (fixtures in fixtures/legacy-team, taken 2026-10-07 from legacy kit 9828540).
const fooPolicy = () => createTeamPolicy(getFooImportedOverrides());
const MAX_FAIL_ROUNDS = 3; // the live thresholds.QAFLOW_MAX_FAILS, imported as pipeline.rework.maxFailRounds

describe("team kit parity with foo's legacy kit.config.json", () => {
	it("imports foo as team with only its project values as overrides", () => {
		const live = readLegacyKitConfig();
		const project = (live.projects as Array<Record<string, unknown>>).find(
			(entry) => entry.workspaceId === "foo",
		) as Record<string, unknown>;
		// Everything foo inherits from the top level (devAgent, qaAgent, the built-in qaRoutes, benchmark tiers and
		// dropped models with the deprecated openai-native provider mapped to bedrock) is what kits/team.json says,
		// except Nova 2 Lite: kits/team.json brought it back on 2026-10-07 (tier3 candidate, qa), the legacy kit still
		// drops it. So an import pins foo's legacy lists as overrides and foo keeps Nova dropped until the user says.
		const overrides = getFooImportedOverrides();
		expect(Object.keys(overrides).sort()).toEqual(
			["qa.blurb", "qa.promptNotes.dbSetup", "land.postLand", "tiers.tier3", "tiers.qa", "dropped"].sort(),
		);
		expect(overrides).toMatchObject({
			"qa.blurb": project.projectBlurb,
			"qa.promptNotes.dbSetup": (project.qaPrompt as Record<string, unknown>).dbSetup,
			"land.postLand": project.postLand,
		});
		const models = (key: string) => (overrides[key] as Array<{ model: string }>).map((entry) => entry.model);
		expect(models("tiers.tier3")).toEqual(["us.openai.gpt-6.1-sol"]);
		expect(models("tiers.qa")).toEqual(["us.anthropic.claude-haiku-4-5-20251001-v1:0", "us.amazon.nova-2-lite-v1:0"]);
		expect(models("dropped")).toContain("us.amazon.nova-2-lite-v1:0");
	});

	it("assigns new dev cards to Cline on the tier-3 default", () => {
		expect(fooPolicy().devAssignment({ workspaceId: "foo", title: "", prompt: "", role: "dev" })).toEqual({
			agentId: "cline",
			model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" },
			tier: "tier3",
		});
	});

	describe("QA routing matches qa/qa-card.cjs --dry-run", () => {
		for (const fixture of readLegacyQaRoutes()) {
			it(fixture.name, () => {
				const dev = toFooEffectiveCard(fixture.card);
				expect(dev.model?.model ?? null, "dev model").toBe(fixture.devModel);
				const answer = fooPolicy().qaPolicy({ dev, round: 1, history: createCardHistory() });
				if (answer.kind !== "qa") {
					throw new Error(`expected a QA answer, got: ${answer.reason}`);
				}
				expect({
					agent: answer.agentId,
					provider: answer.model?.provider ?? null,
					model: answer.model?.model ?? null,
					route: answer.route,
					rules: answer.promptParts.rules.length,
				}).toEqual({
					agent: fixture.qaAgent,
					provider: fixture.qaProvider,
					model: fixture.qaModel,
					route: fixture.route === null ? null : `qa.routes[${fixture.route}]`,
					rules: fixture.rules.length,
				});
			});
		}
	});

	// Ported from archive/devteam-kit:services/kanban-autoland.mjs@9828540 (createQa/isFlowDevCard: QA ("QA<n> <dev>:",
	// "BENCH QA …"), calibration (QA-CAL) and TRIAGE cards never get QA). The legacy kit set no `role`, so
	// these cards reach the pipeline role-less and src/core/card-role.ts reads the kit's creation markers.
	it("never QAs the legacy kit's own QA, calibration and TRIAGE cards", () => {
		const legacyCards: Array<[LegacyCard, string]> = [
			[{ id: "q0001", agentId: "codex", title: "QA2 d0001: Add a wishlist page" }, "qa"],
			[
				{
					id: "q0002",
					agentId: "cline",
					title: "",
					prompt: 'You are the QA reviewer (round 1) for Kanban dev card d0001 ("x")',
				},
				"qa",
			],
			[{ id: "q0003", agentId: "cline", title: "BENCH QA d0001: judge run" }, "qa"],
			[{ id: "c0001", agentId: "cline", title: "QA-CAL qa-models-v5 haiku" }, "calibration"],
			[
				{
					id: "c0002",
					agentId: "cline",
					prompt: "You are the QA reviewer (calibration qa-models-v5 k1) for a Kanban dev card",
				},
				"calibration",
			],
			[{ id: "t0001", agentId: "claude", title: "TRIAGE d0001: QA card stalled" }, "triage"],
		];
		for (const [card, role] of legacyCards) {
			const dev = toFooEffectiveCard(card);
			expect(dev.role, card.id).toBe(role);
			expect(fooPolicy().qaPolicy({ dev, round: 1, history: createCardHistory() }).kind, card.id).toBe("none");
		}
		// A dev card that only mentions QA in its title is still a dev card.
		const dev = toFooEffectiveCard({ id: "d0011", agentId: "cline", title: "QA gate: verdict ingest" });
		expect(dev.role).toBe("dev");
	});

	it("QAs Claude-built dev cards (by Codex), which the legacy kit skipped on the literal agent id", () => {
		// Deliberate difference (plan §12): the legacy kit skipped cards whose agent was "claude". With
		// qa.skip.effectiveAgents: [] the team kit QAs them with a different vendor. The P5-1 shadow diff shows it.
		const dev = toFooEffectiveCard({ id: "d0012", agentId: "claude" });
		expect(fooPolicy().qaPolicy({ dev, round: 1, history: createCardHistory() })).toMatchObject({
			kind: "qa",
			agentId: "codex",
		});
	});

	describe("after a FAIL, like autoland's onVerdict", () => {
		// Ported from archive/devteam-kit:services/kanban-autoland.mjs@9828540 (onVerdict, failRoundsOf, maxFailsOf):
		// a FAIL or a land conflict counts as a failed round; below QAFLOW_MAX_FAILS (+ handback rounds) the card is
		// reworked on its own model; at the cap, and on STALLED/DNF or an unchanged rework, it is escalated.
		// "rework impossible" (a card that isn't on Cline or has no model) is a core rule, not the kit's.
		const cases: Array<{
			name: string;
			cause: FailCause;
			failRounds: number[];
			extraRounds?: number;
			legacy: OnFailAnswer["action"];
		}> = [
			{ name: "first FAIL", cause: "fail", failRounds: [1], legacy: "rework" },
			{ name: "second FAIL", cause: "fail", failRounds: [1, 2], legacy: "rework" },
			{ name: "third FAIL", cause: "fail", failRounds: [1, 2, 3], legacy: "escalate" },
			{
				name: "third FAIL after a handback of 2 rounds",
				cause: "fail",
				failRounds: [1, 2, 3],
				extraRounds: 2,
				legacy: "rework",
			},
			{
				name: "fifth FAIL after a handback of 2 rounds",
				cause: "fail",
				failRounds: [1, 2, 3, 4, 5],
				extraRounds: 2,
				legacy: "escalate",
			},
			{
				name: "PASS that conflicts at land, after one FAIL",
				cause: "conflict",
				failRounds: [1, 2],
				legacy: "rework",
			},
			{ name: "conflict as the third failed round", cause: "conflict", failRounds: [1, 2, 3], legacy: "escalate" },
			{ name: "STALLED (or DNF)", cause: "stalled", failRounds: [], legacy: "escalate" },
			{ name: "rework came back unchanged", cause: "unchanged", failRounds: [1], legacy: "escalate" },
		];
		for (const testCase of cases) {
			it(testCase.name, () => {
				const answer = fooPolicy().onFail({
					dev: toFooEffectiveCard(readLegacyQaRoutes()[0]?.card as LegacyCard),
					cause: testCase.cause,
					verdict: null,
					history: createCardHistory(testCase.failRounds, testCase.extraRounds ?? 0),
					limits: { maxFailRounds: MAX_FAIL_ROUNDS },
				});
				expect(answer.action).toBe(testCase.legacy);
				if (answer.action === "escalate") {
					// The legacy kit parked escalated cards as "BLOCKED:" and woke the orchestrator. Since 2026-10-09 the team
					// kit hands the card to its fallback role first (user: the fallback is team definition, not a foo
					// override), without approval; the card is still parked as BLOCKED.
					expect(answer).toMatchObject({
						to: { agentId: "cline", model: { provider: "bedrock", model: "us.moonshotai.kimi-k3" } },
						requireApproval: false,
					});
				}
				if (answer.action === "rework") {
					expect(answer.clearContext).toBe("auto");
				}
			});
		}
	});

	it("lands after a PASS (runoff holds are the team runoffs feature, not the kit)", () => {
		const dev = toFooEffectiveCard(readLegacyQaRoutes()[0]?.card as LegacyCard);
		expect(fooPolicy().onPass({ dev, verdict: { verdict: "PASS", round: 1 } })).toEqual({ action: "land" });
	});
});
