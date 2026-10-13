import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkKitLemonadeModels, checkKitRecommendedSettings } from "../../../src/doctor/kit-settings-checks";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import {
	createFakeLemonadeFetch,
	LEMONADE_HEALTH_IDLE_PAYLOAD,
	LEMONADE_MODELS_PAYLOAD,
} from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

async function builtInCatalog() {
	const { path, cleanup } = createTempDir("kanban-kits-");
	try {
		return await loadKitCatalog(path);
	} finally {
		cleanup();
	}
}

const LEMONADE = { url: "http://localhost:13305", requireLabels: ["tool-calling"], include: null };
const LOCAL_ON = {
	agents: { cline: { turnDetector: { mode: "on" } } },
	pipeline: { recovery: { mode: "on" } },
};

/** The fixture list plus team-local's dev and QA models (on the pod since 2026-10-12), without its fallback model. */
const WITH_TEAM_LOCAL_ROLES = {
	...LEMONADE_MODELS_PAYLOAD,
	data: [
		...LEMONADE_MODELS_PAYLOAD.data,
		...["Qwen3.8-27B-GGUF-UD-Q4_K_XL", "Muse-Glimmer-30B-GGUF-Q4_K_M"].map((id) => ({
			id,
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["vision", "tool-calling"],
		})),
	],
};

function onTeamLocal(extra: Record<string, unknown> = {}) {
	return {
		...extra,
		workspaces: { local: { landing: { mode: "qa" }, kit: { name: "team-local", overrides: {} } }, foo: {} },
	};
}

describe("kit settings doctor rows", () => {
	it("warns for every setting team (lemonade) needs and the config doesn't have, with the key to set", async () => {
		const findings = checkKitRecommendedSettings({
			config: parsePipelineConfig(onTeamLocal()).config,
			catalog: await builtInCatalog(),
			entries: [{ workspaceId: "local" }, { workspaceId: "foo" }],
		});
		// The team kit's recovery settings first, then the lemonade preset's own (the turn detector).
		expect(findings.map((finding) => [finding.level, finding.hint])).toEqual([
			["warn", 'set pipeline.recovery.mode to "on" in config.json (the kit never applies it)'],
			["warn", 'set agents.cline.turnDetector.mode to "on" in config.json (the kit never applies it)'],
		]);
		expect(findings[1]?.message).toContain("local: kit team (lemonade) needs agents.cline.turnDetector.mode");
	});

	it("passes once they are set, and says nothing about projects on the default kit", async () => {
		const findings = checkKitRecommendedSettings({
			config: parsePipelineConfig(onTeamLocal(LOCAL_ON)).config,
			catalog: await builtInCatalog(),
			entries: [{ workspaceId: "local" }, { workspaceId: "foo" }],
		});
		expect(findings).toEqual([
			{ level: "pass", area: "project", message: "local: the 3 setting(s) kit team (lemonade) needs are set" },
		]);
	});

	it("warns about a kit's Lemonade models the server doesn't list, and is INFO when Lemonade is down", async () => {
		const context = {
			config: parsePipelineConfig(onTeamLocal(LOCAL_ON)).config,
			catalog: await builtInCatalog(),
			entries: [{ workspaceId: "local" }, { workspaceId: "foo" }],
			lemonadeModelList: LEMONADE,
		};
		// The fixture is the pod's list of 10/07 plus the dev and QA models, without the fallback model.
		const findings = await checkKitLemonadeModels({
			...context,
			fetch: createFakeLemonadeFetch({ models: WITH_TEAM_LOCAL_ROLES }),
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			level: "warn",
			message:
				"local: kit team (lemonade) routes to Lemonade models it can't run: Qwen3-Coder-30B-A3B-Instruct-GGUF-Q4_K_M is not listed by Lemonade",
		});
		const down = await checkKitLemonadeModels({ ...context, fetch: createFakeLemonadeFetch({ down: true }) });
		expect(down).toMatchObject([{ level: "info", message: expect.stringContaining("did not answer") }]);
	});

	it("reads Lemonade's max_models.llm and warns while it can't hold the kit's dev, QA and fallback models", async () => {
		const context = {
			config: parsePipelineConfig(onTeamLocal(LOCAL_ON)).config,
			catalog: await builtInCatalog(),
			entries: [{ workspaceId: "local" }],
			lemonadeModelList: LEMONADE,
		};
		const health = (llm: number) => ({ ...LEMONADE_HEALTH_IDLE_PAYLOAD, max_models: { llm } });
		const one = await checkKitLemonadeModels({ ...context, fetch: createFakeLemonadeFetch({ health: health(1) }) });
		expect(one.find((finding) => finding.message.includes("max_models.llm"))).toMatchObject({
			level: "warn",
			hint: expect.stringMatching(/LEMONADE_MAX_LOADED_MODELS=3 .*lemonade config set max_loaded_models=3/u),
		});
		const three = await checkKitLemonadeModels({
			...context,
			config: parsePipelineConfig(
				onTeamLocal({ ...LOCAL_ON, models: { providerCapacity: { lemonade: { maxLoadedModels: 3 } } } }),
			).config,
			fetch: createFakeLemonadeFetch({ health: health(3) }),
		});
		expect(three.filter((finding) => finding.message.includes("side by side"))).toMatchObject([{ level: "pass" }]);
	});

	it("checks nothing when no project routes to Lemonade", async () => {
		const fake = createFakeLemonadeFetch();
		const findings = await checkKitLemonadeModels({
			config: parsePipelineConfig({ workspaces: { foo: { kit: { name: "team-cloud", overrides: {} } } } }).config,
			catalog: await builtInCatalog(),
			entries: [{ workspaceId: "foo" }],
			lemonadeModelList: LEMONADE,
			fetch: fake,
		});
		expect(findings).toEqual([]);
		expect(fake.urls).toEqual([]);
	});
});
