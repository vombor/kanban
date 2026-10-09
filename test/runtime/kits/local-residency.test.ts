import { describe, expect, it } from "vitest";

import { assessLocalResidency, listKitLocalWorkingSet } from "../../../src/kits/local-residency";
import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../src/kits/resolve-kit";

function resolveBuiltIn(name: string, overrides: Record<string, unknown> = {}) {
	const kit = getBuiltInKits().get(name);
	if (!kit) {
		throw new Error(`${name} kit missing`);
	}
	const resolved = resolveKitLayers(getDefaultKit(), kit, overrides);
	if (!resolved.ok) {
		throw new Error(resolved.error);
	}
	return resolved.kit;
}

const TEAM_LOCAL_SET = ["GLM-4.7-Flash-GGUF", "Gemma-4-12B-it-GGUF", "Qwen3.6-35B-A3B-MTP-GGUF"];

describe("local residency", () => {
	it("counts the local models team-local runs at once: dev (= plan), QA and fallback", () => {
		expect(listKitLocalWorkingSet(resolveBuiltIn("team-local"))).toEqual(TEAM_LOCAL_SET);
		expect(listKitLocalWorkingSet(resolveBuiltIn("team"))).toEqual([]);
		expect(listKitLocalWorkingSet(resolveBuiltIn("team-local", { "escalate.to": "orchestrator" }))).toEqual(
			TEAM_LOCAL_SET.slice(0, 2),
		);
	});

	it("warns when Lemonade keeps fewer LLMs than that, naming the container env var and the CLI", () => {
		const findings = assessLocalResidency({
			kitName: "team-local",
			workingSet: TEAM_LOCAL_SET,
			lemonadeMaxLlm: 1,
			kanbanCapacity: 1,
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			level: "warn",
			message: expect.stringContaining("Kanban runs at most 1 model(s) at a time"),
			hint: expect.stringContaining("LEMONADE_MAX_LOADED_MODELS=3"),
		});
		expect(findings[0]?.hint).toContain("lemonade config set max_loaded_models=3");
	});

	it("warns when Kanban's limit is above Lemonade's (thrash) or below the kit's need (waits for nothing)", () => {
		const above = assessLocalResidency({
			kitName: "k",
			workingSet: TEAM_LOCAL_SET,
			lemonadeMaxLlm: 2,
			kanbanCapacity: 3,
		});
		expect(above.map((finding) => finding.hint)).toEqual([
			expect.stringContaining("max_loaded_models=3"),
			"set models.providerCapacity.lemonade.maxLoadedModels to 2 in config.json, or raise Lemonade's limit",
		]);
		const below = assessLocalResidency({
			kitName: "k",
			workingSet: TEAM_LOCAL_SET,
			lemonadeMaxLlm: 3,
			kanbanCapacity: 1,
		});
		expect(below).toMatchObject([
			{ level: "warn", hint: "set models.providerCapacity.lemonade.maxLoadedModels to 3 in config.json" },
		]);
	});

	it("passes when both hold the set (Lemonade -1 is unlimited), and says nothing for one local model", () => {
		expect(
			assessLocalResidency({ kitName: "k", workingSet: TEAM_LOCAL_SET, lemonadeMaxLlm: -1, kanbanCapacity: 3 }),
		).toMatchObject([{ level: "pass" }]);
		expect(
			assessLocalResidency({
				kitName: "k",
				workingSet: ["GLM-4.7-Flash-GGUF"],
				lemonadeMaxLlm: 1,
				kanbanCapacity: 1,
			}),
		).toEqual([]);
	});
});
