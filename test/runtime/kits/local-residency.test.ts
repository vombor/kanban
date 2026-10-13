import { describe, expect, it } from "vitest";

import { assessLocalResidency, listKitLocalWorkingSet } from "../../../src/kits/local-residency";
import { resolveTeamKit } from "../../utilities/team-kits";

const TEAM_LOCAL_SET = [
	"Muse-Glimmer-30B-GGUF-Q4_K_M",
	"gemma-4-E4B-it-GGUF-Q4_K_M",
	"Qwen3-Coder-30B-A3B-Instruct-GGUF-Q4_K_M",
];

describe("local residency", () => {
	it("counts the local models team (lemonade) runs at once: dev (= plan), QA and fallback", () => {
		expect(listKitLocalWorkingSet(resolveTeamKit("lemonade"))).toEqual(TEAM_LOCAL_SET);
		expect(listKitLocalWorkingSet(resolveTeamKit("cloud"))).toEqual([]);
		expect(listKitLocalWorkingSet(resolveTeamKit("lemonade", { "escalate.to": "orchestrator" }))).toEqual(
			TEAM_LOCAL_SET.slice(0, 2),
		);
	});

	it("warns when Lemonade keeps fewer LLMs than that, naming the container env var and the CLI", () => {
		const findings = assessLocalResidency({
			kitName: "team-local",
			workingSet: TEAM_LOCAL_SET,
			providerMaxLoaded: 1,
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
			providerMaxLoaded: 2,
			kanbanCapacity: 3,
		});
		expect(above.map((finding) => finding.hint)).toEqual([
			expect.stringContaining("max_loaded_models=3"),
			"set models.providerCapacity.lemonade.maxLoadedModels to 2 in config.json, or raise Lemonade's limit",
		]);
		const below = assessLocalResidency({
			kitName: "k",
			workingSet: TEAM_LOCAL_SET,
			providerMaxLoaded: 3,
			kanbanCapacity: 1,
		});
		expect(below).toMatchObject([
			{ level: "warn", hint: "set models.providerCapacity.lemonade.maxLoadedModels to 3 in config.json" },
		]);
	});

	it("passes when both hold the set (Lemonade -1 is unlimited), and says nothing for one local model", () => {
		expect(
			assessLocalResidency({ kitName: "k", workingSet: TEAM_LOCAL_SET, providerMaxLoaded: -1, kanbanCapacity: 3 }),
		).toMatchObject([{ level: "pass" }]);
		expect(
			assessLocalResidency({
				kitName: "k",
				workingSet: ["Qwen3.8-27B-GGUF-UD-Q4_K_XL"],
				providerMaxLoaded: 1,
				kanbanCapacity: 1,
			}),
		).toEqual([]);
	});

	it("names another provider's own capacity key and a generic hint", () => {
		const findings = assessLocalResidency({
			kitName: "k",
			provider: "ollama",
			workingSet: ["qwen3-coder", "gemma-4"],
			providerMaxLoaded: 1,
			kanbanCapacity: 1,
		});
		expect(findings).toMatchObject([
			{
				level: "warn",
				message: expect.stringContaining("ollama keeps 1 model(s) loaded"),
				hint: "let ollama keep 2 models loaded",
			},
		]);
		expect(findings[0]?.message).toContain("models.providerCapacity.ollama.maxLoadedModels");
	});
});
