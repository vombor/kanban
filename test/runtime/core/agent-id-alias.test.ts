import { describe, expect, it } from "vitest";
import { RUNTIME_AGENT_CATALOG, RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS } from "../../../src/core/agent-catalog";
import {
	normalizeRuntimeAgentIdAlias,
	runtimeAgentIdEnumSchema,
	runtimeAgentIdSchema,
	runtimeBoardCardSchema,
	runtimeTaskSessionStartRequestSchema,
} from "../../../src/core/api-contract";

// "cline" is the Cline CLI; "cline-cli" is the old id of the same agent and stays accepted for old cards.
describe("cline-cli agent id alias", () => {
	it("normalizes cline-cli to cline and leaves other ids alone", () => {
		expect(normalizeRuntimeAgentIdAlias("cline-cli")).toBe("cline");
		expect(normalizeRuntimeAgentIdAlias("cline")).toBe("cline");
		expect(normalizeRuntimeAgentIdAlias("claude")).toBe("claude");
		expect(runtimeAgentIdSchema.parse("cline-cli")).toBe("cline");
	});

	it("does not list cline-cli as its own agent id", () => {
		expect(runtimeAgentIdEnumSchema.options).not.toContain("cline-cli");
		expect(runtimeAgentIdSchema.safeParse("not-an-agent").success).toBe(false);
	});

	it("normalizes stored board cards on load", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "abc12",
			prompt: "Add coupons",
			startInPlanMode: false,
			agentId: "cline-cli",
			agentSettings: { providerId: "bedrock", modelId: "us.anthropic.claude-opus-5-5" },
			baseRef: "master",
			createdAt: 1,
			updatedAt: 1,
		});
		expect(card.agentId).toBe("cline");
		expect(card.agentSettings).toEqual({ providerId: "bedrock", modelId: "us.anthropic.claude-opus-5-5" });
	});

	it("accepts the alias in session start requests", () => {
		const request = runtimeTaskSessionStartRequestSchema.parse({
			taskId: "abc12",
			prompt: "Add coupons",
			baseRef: "master",
			agentId: "cline-cli",
		});
		expect(request.agentId).toBe("cline");
	});
});

describe("agent catalog", () => {
	it("has exactly one Cline entry, labelled Cline, that launches the cline CLI", () => {
		const clineEntries = RUNTIME_AGENT_CATALOG.filter((entry) => entry.binary === "cline");
		expect(clineEntries).toHaveLength(1);
		expect(clineEntries[0]).toMatchObject({ id: "cline", label: "Cline", binary: "cline" });
		expect(clineEntries[0]?.capabilities).toMatchObject({
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "flag",
		});
		expect(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS).toContain("cline");
	});

	it("never labels an agent Cline CLI", () => {
		expect(RUNTIME_AGENT_CATALOG.some((entry) => entry.label.includes("Cline CLI"))).toBe(false);
	});
});
