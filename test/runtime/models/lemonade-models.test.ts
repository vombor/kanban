import { describe, expect, it } from "vitest";

import {
	fetchLemonadeCatalog,
	isListedLemonadeModel,
	parseLemonadeModels,
	resolveLemonadeContextWindow,
} from "../../../src/models/lemonade-models";
import {
	createFakeLemonadeFetch,
	LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD,
	LEMONADE_MODELS_PAYLOAD,
} from "../../utilities/lemonade-fixtures";

const API = "http://lemonade.test:13305/api/v1";

function model(id: string) {
	const found = parseLemonadeModels(LEMONADE_MODELS_PAYLOAD).find((entry) => entry.id === id);
	if (!found) {
		throw new Error(`no ${id} in the fixture`);
	}
	return found;
}

const IDLE = { globalCtxSize: null, loadedCtxSizes: new Map<string, number>() };

describe("Lemonade models", () => {
	it("reads ids, labels, the model max and a positive recipe ctx_size", () => {
		expect(model("GLM-4.7-Flash-GGUF")).toEqual({
			id: "GLM-4.7-Flash-GGUF",
			ownedBy: "lemonade",
			labels: ["tool-calling"],
			downloaded: true,
			maxContextWindow: 202752,
			recipeCtxSize: 202752,
		});
		expect(model("Mystery-Coder-GGUF")).toMatchObject({ maxContextWindow: null, recipeCtxSize: null });
		expect(parseLemonadeModels({ data: [{ id: 1 }, "x", { id: "ok" }] }).map((entry) => entry.id)).toEqual(["ok"]);
	});

	it("lists downloaded models with every required label", () => {
		const listed = parseLemonadeModels(LEMONADE_MODELS_PAYLOAD)
			.filter((entry) => isListedLemonadeModel(entry, ["tool-calling"]))
			.map((entry) => entry.id);
		expect(listed).toEqual([
			"Devstral-Small-2507-GGUF",
			"GLM-4.7-Flash-GGUF",
			"Gemma-4-12B-it-GGUF",
			"Qwen3.6-35B-A3B-MTP-GGUF",
			"gpt-oss-20b-mxfp4-GGUF",
			"Mystery-Coder-GGUF",
		]);
	});

	it("takes the window llama-server runs with: loaded, then recipe, then global, then the model max", () => {
		expect(resolveLemonadeContextWindow(model("GLM-4.7-Flash-GGUF"), IDLE)).toEqual({
			tokens: 202752,
			source: "recipe",
		});
		expect(resolveLemonadeContextWindow(model("Devstral-Small-2507-GGUF"), IDLE)).toEqual({
			tokens: 131072,
			source: "recipe",
		});
		// The recipe wins over a larger model max.
		expect(resolveLemonadeContextWindow(model("Gemma-4-12B-it-GGUF"), IDLE)?.tokens).toBe(65536);
		// Auto (-1) everywhere: the model max is the bound.
		expect(resolveLemonadeContextWindow(model("Qwen3.6-35B-A3B-MTP-GGUF"), IDLE)).toEqual({
			tokens: 262144,
			source: "model-max",
		});
		// A positive global ctx_size is what llama-server gets for a model without its own.
		expect(
			resolveLemonadeContextWindow(model("Qwen3.6-35B-A3B-MTP-GGUF"), { ...IDLE, globalCtxSize: 16384 }),
		).toEqual({ tokens: 16384, source: "global" });
		// A loaded model's effective size beats everything.
		expect(
			resolveLemonadeContextWindow(model("GLM-4.7-Flash-GGUF"), {
				globalCtxSize: 16384,
				loadedCtxSizes: new Map([["GLM-4.7-Flash-GGUF", 100000]]),
			}),
		).toEqual({ tokens: 100000, source: "loaded" });
		expect(resolveLemonadeContextWindow(model("Mystery-Coder-GGUF"), IDLE)).toBeNull();
	});

	it("fetches the catalog with the global ctx_size and the loaded models' sizes", async () => {
		const fetchImpl = createFakeLemonadeFetch({
			params: { ctx_size: 8192 },
			health: LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD,
		});
		const catalog = await fetchLemonadeCatalog(`${API}/`, fetchImpl);
		expect(catalog.models).toHaveLength(LEMONADE_MODELS_PAYLOAD.data.length);
		expect(catalog.globalCtxSize).toBe(8192);
		expect([...catalog.loadedCtxSizes]).toEqual([["Qwen3.6-35B-A3B-MTP-GGUF", 98304]]);
		expect(fetchImpl.urls.sort()).toEqual([`${API}/health`, `${API}/models`, `${API}/params`]);
	});

	it("needs only the model list: an older Lemonade without /params or /health still resolves", async () => {
		const catalog = await fetchLemonadeCatalog(API, createFakeLemonadeFetch({ missing: ["params", "health"] }));
		expect(catalog.globalCtxSize).toBeNull();
		expect(catalog.loadedCtxSizes.size).toBe(0);
		await expect(fetchLemonadeCatalog(API, createFakeLemonadeFetch({ missing: ["models"] }))).rejects.toThrow(
			"lemonade HTTP 404",
		);
		await expect(fetchLemonadeCatalog(API, createFakeLemonadeFetch({ down: true }))).rejects.toThrow("fetch failed");
	});
});
