import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeAgentId } from "../../../src/core/api-contract";
import { createRoutingPolicy, type FailCause } from "../../../src/kits/policy";
import { getBuiltInKits, getDefaultKit, resolveWorkspaceKit } from "../../../src/kits/resolve-kit";
import { createCardHistory, createEffectiveCard } from "../../utilities/effective-card";

// The default kit answers "no" to every routing question (plan §4.0): no assignment, no QA, no rework, land.
const AGENTS: RuntimeAgentId[] = ["claude", "codex", "cline", "copilot"];
const CAUSES: FailCause[] = ["fail", "conflict", "stalled", "unchanged"];

describe("default kit", () => {
	const policy = createRoutingPolicy(getDefaultKit());

	it("assigns nothing at card creation", () => {
		expect(policy.devAssignment({ workspaceId: "ws", title: "t", prompt: "p", role: "dev" })).toBeNull();
	});

	it("never asks for QA, whatever the card's agent or model", () => {
		for (const agentId of AGENTS) {
			for (const model of [null, "us.openai.gpt-6.1-sol", "us.anthropic.claude-opus-5-5"]) {
				const answer = policy.qaPolicy({
					dev: createEffectiveCard({ agentId, model }),
					round: 1,
					history: createCardHistory(),
				});
				expect(answer.kind).toBe("none");
			}
		}
	});

	it("stops after every kind of failure, without rework or escalation", () => {
		for (const cause of CAUSES) {
			const answer = policy.onFail({
				dev: createEffectiveCard({ agentId: "cline", model: "us.openai.gpt-6.1-sol" }),
				cause,
				verdict: cause === "fail" ? { verdict: "FAIL", round: 1 } : null,
				history: createCardHistory([1]),
				limits: { maxFailRounds: 3 },
			});
			expect(answer.action).toBe("stop");
		}
	});

	it("lands after a PASS (no hold)", () => {
		expect(
			policy.onPass({ dev: createEffectiveCard({ agentId: "claude" }), verdict: { verdict: "PASS", round: 1 } }),
		).toEqual({ action: "land" });
	});

	it("is what a workspace without a kit resolves to, even next to a team workspace", () => {
		const { config } = parsePipelineConfig({ workspaces: { foo: { kit: { name: "team" } } } });
		const catalog = {
			kits: new Map(
				[...getBuiltInKits()].map(([name, kit]) => [name, { kit, origin: { kind: "built-in" as const } }]),
			),
			errors: [],
		};
		const resolved = resolveWorkspaceKit(config, "kanban-2uge", catalog);
		const workspacePolicy = createRoutingPolicy(resolved.kit);
		expect(
			workspacePolicy.devAssignment({ workspaceId: "kanban-2uge", title: "", prompt: "", role: "dev" }),
		).toBeNull();
		expect(
			workspacePolicy.qaPolicy({
				dev: createEffectiveCard({ agentId: "claude", workspaceId: "kanban-2uge" }),
				round: 1,
				history: createCardHistory(),
			}).kind,
		).toBe("none");
	});
});
