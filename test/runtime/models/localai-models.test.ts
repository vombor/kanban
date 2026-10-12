import { afterEach, describe, expect, it } from "vitest";
import {
	fetchLocalAiMaxLoadedModels,
	fetchLocalAiModelLoaded,
	fetchLocalAiModels,
	isListedLocalAiModel,
	localAiApiBaseUrl,
	localAiRootUrl,
	probeLocalAiHealth,
} from "../../../src/models/localai-models";
import { canProbeProvider, probeModel } from "../../../src/models/model-probe";
import {
	type FakeLocalAi,
	getRefusingLocalAiUrl,
	LOCALAI_CHAT_MODEL_IDS,
	LOCALAI_MODELS_PAYLOAD,
	startFakeLocalAi,
} from "../../utilities/localai-fixtures";

describe("LocalAI models", () => {
	let localai: FakeLocalAi | null = null;

	afterEach(async () => {
		await localai?.close();
		localai = null;
	});

	it("reads the root and API URLs whichever form the user gives", () => {
		expect(localAiRootUrl("http://localai.test/")).toBe("http://localai.test");
		expect(localAiRootUrl("http://localai.test/v1/")).toBe("http://localai.test");
		expect(localAiApiBaseUrl("http://localai.test")).toBe("http://localai.test/v1");
		expect(localAiApiBaseUrl("http://localai.test/v1")).toBe("http://localai.test/v1");
	});

	it("lists models with their capabilities and context size, leaving out models that can't chat", async () => {
		localai = await startFakeLocalAi();
		const models = await fetchLocalAiModels(`${localai.url}/v1`);
		expect(localai.requests).toEqual(["/v1/models/capabilities"]);
		expect(models.find((model) => model.id === "ornith-1.5-35b-a3b-apex")).toEqual({
			id: "ornith-1.5-35b-a3b-apex",
			ownedBy: "localai",
			capabilities: ["chat", "vision", "thinking"],
			contextSize: 262144,
		});
		expect(models.find((model) => model.id === "qwen3-coder-next-q8-0-qwen")?.contextSize).toBeNull();
		expect(models.filter((model) => isListedLocalAiModel(model, ["chat"])).map((model) => model.id)).toEqual(
			LOCALAI_CHAT_MODEL_IDS,
		);
	});

	it("falls back to the plain list on a LocalAI without the capabilities route, and lists all of it", async () => {
		localai = await startFakeLocalAi({ routes: { "/v1/models": LOCALAI_MODELS_PAYLOAD } });
		const models = await fetchLocalAiModels(localai.url);
		expect(localai.requests).toEqual(["/v1/models/capabilities", "/v1/models"]);
		expect(models).toHaveLength(LOCALAI_MODELS_PAYLOAD.data.length);
		expect(models.every((model) => model.capabilities === null && isListedLocalAiModel(model, ["chat"]))).toBe(true);
	});

	it("reads how many models LocalAI keeps loaded from /api/settings", async () => {
		localai = await startFakeLocalAi();
		expect(await fetchLocalAiMaxLoadedModels(localai.url)).toBe(1);
		await localai.close();
		localai = await startFakeLocalAi({
			routes: { "/api/settings": { max_active_backends: 3, single_backend: false } },
		});
		expect(await fetchLocalAiMaxLoadedModels(localai.url)).toBe(3);
		await localai.close();
		// 0 is LocalAI's "unlimited", said as -1 like Lemonade's.
		localai = await startFakeLocalAi({
			routes: { "/api/settings": { max_active_backends: 0, single_backend: false } },
		});
		expect(await fetchLocalAiMaxLoadedModels(localai.url)).toBe(-1);
		await localai.close();
		// The old flag alone means one.
		localai = await startFakeLocalAi({ routes: { "/api/settings": { single_backend: true } } });
		expect(await fetchLocalAiMaxLoadedModels(localai.url)).toBe(1);
		await localai.close();
		// A LocalAI with API keys refuses the settings route: unknown, not an error.
		localai = await startFakeLocalAi({ routes: { "/api/settings": 401 } });
		expect(await fetchLocalAiMaxLoadedModels(localai.url)).toBeNull();
	});

	it("tells whether a model is loaded right now from /system", async () => {
		localai = await startFakeLocalAi();
		expect(await fetchLocalAiModelLoaded(localai.url, "ornith-1.5-35b-a3b-apex")).toBe(true);
		expect(await fetchLocalAiModelLoaded(localai.url, "gemma-4-26b-a4b-it")).toBe(false);
		expect(await fetchLocalAiModelLoaded(await getRefusingLocalAiUrl(), "gemma-4-26b-a4b-it")).toBeNull();
	});

	it("probes /readyz: up when LocalAI answers, down (not an error) when its host refuses connections", async () => {
		localai = await startFakeLocalAi();
		expect(await probeLocalAiHealth(`${localai.url}/v1`)).toEqual({
			up: true,
			url: `${localai.url}/readyz`,
			status: 200,
			detail: "ready",
		});
		const refusing = await getRefusingLocalAiUrl();
		const down = await probeLocalAiHealth(refusing);
		expect(down).toMatchObject({ up: false, url: `${refusing}/readyz`, status: null });
		expect(down.detail).toContain("ECONNREFUSED");
	});

	it("gives a localai card the outage probe, which reads LocalAI's health", async () => {
		expect(canProbeProvider("localai")).toBe(true);
		localai = await startFakeLocalAi();
		const deps = { bedrock: null, lemonadeBaseUrl: "http://lemonade.test/api/v1" };
		expect(
			await probeModel(
				{ provider: "localai", model: "ornith-1.5-35b-a3b-apex" },
				{ ...deps, localAiUrl: localai.url },
			),
		).toMatchObject({ kind: "health", up: true });
		expect(
			await probeModel(
				{ provider: "localai", model: "ornith-1.5-35b-a3b-apex" },
				{ ...deps, localAiUrl: await getRefusingLocalAiUrl() },
			),
		).toMatchObject({ kind: "health", up: false });
		// No URL known: down with the reason, so the hold keeps probing until the user sets it up.
		expect(
			await probeModel({ provider: "localai", model: "ornith-1.5-35b-a3b-apex" }, { ...deps, localAiUrl: null }),
		).toMatchObject({ kind: "health", up: false, detail: expect.stringContaining("models.lists.localai.url") });
	});
});
