// OpenAI-compatible providers of config.json (`providers.openaiCompatible.<id>`): the config schema, the registry that
// readPipelineConfig fills, the model-list reader (Triton's real payload), and every provider-id rule that knows them
// (local pricing and QA slots, the outage probe, the loaded flag, the TUI sign-in rule, vendors, the checks' secrets).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parsePipelineConfig, readPipelineConfig } from "../../../src/config/pipeline-config";
import { getModelVendor } from "../../../src/kits/policy";
import { createPriceTable, isLocalProvider, isUnmeteredProvider } from "../../../src/kits/team/bench/prices";
import { canProbeProvider, probeModel } from "../../../src/models/model-probe";
import {
	fetchOpenAiCompatibleModelLoaded,
	fetchOpenAiCompatibleModels,
	getConfiguredOpenAiCompatibleProvider,
	listConfiguredProviderKeyEnvNames,
	parseOpenAiCompatibleModels,
	setConfiguredOpenAiCompatibleProviders,
} from "../../../src/models/openai-compatible-providers";
import { createCheckStepEnv } from "../../../src/pipeline/checks";
import { isSetupProviderId } from "../../../src/setup/setup-provider-command";
import { describeClineTuiSignInGap } from "../../../src/terminal/cline-tui-sign-in";
import {
	createFakeOpenAiCompatibleFetch,
	type FakeOpenAiCompatibleServer,
	getRefusingOpenAiCompatibleBaseUrl,
	startFakeOpenAiCompatibleServer,
	TRITON_MODELS_PAYLOAD,
	tritonProvider,
} from "../../utilities/openai-compatible-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const TRITON_URL = "http://triton.test/v1";

afterEach(() => {
	setConfiguredOpenAiCompatibleProviders({});
});

describe("providers.openaiCompatible in config.json", () => {
	it("parses an entry with its defaults", () => {
		const { config, issues } = parsePipelineConfig({
			providers: { openaiCompatible: { triton: { name: "Triton", baseUrl: TRITON_URL, local: true } } },
		});
		expect(issues).toEqual([]);
		expect(config.providers.openaiCompatible.triton).toEqual({
			name: "Triton",
			baseUrl: TRITON_URL,
			local: true,
			models: {},
		});
		expect(parsePipelineConfig({}).config.providers.openaiCompatible).toEqual({});
	});

	it("refuses a reserved id, a bad URL and an unknown key (the section falls back to its defaults)", () => {
		for (const entry of [
			{ lemonade: { name: "x", baseUrl: TRITON_URL, local: true } },
			{ triton: { name: "x", baseUrl: "triton.test", local: true } },
			{ triton: { name: "x", baseUrl: TRITON_URL, local: true, modelsSourceUrl: "http://x" } },
			{ triton: { name: "x", baseUrl: TRITON_URL } },
		]) {
			const { config, issues } = parsePipelineConfig({ providers: { openaiCompatible: entry } });
			expect(issues.join("\n"), JSON.stringify(entry)).toContain("providers:");
			expect(config.providers.openaiCompatible).toEqual({});
		}
	});

	it("readPipelineConfig makes the configured providers known to the rules that take no config", async () => {
		const dir = createTempDir("kanban-openai-compatible-config-");
		try {
			const configPath = join(dir.path, "config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					providers: { openaiCompatible: { triton: { name: "Triton", baseUrl: TRITON_URL, local: true } } },
				}),
			);
			expect(getConfiguredOpenAiCompatibleProvider("triton")).toBeNull();
			await readPipelineConfig(configPath);
			expect(getConfiguredOpenAiCompatibleProvider("triton")).toMatchObject({ baseUrl: TRITON_URL });
			writeFileSync(configPath, "{}");
			await readPipelineConfig(configPath);
			expect(getConfiguredOpenAiCompatibleProvider("triton")).toBeNull();
		} finally {
			dir.cleanup();
		}
	});
});

describe("the model list", () => {
	it("reads Triton's list: ids and loaded flags, no context window", () => {
		expect(parseOpenAiCompatibleModels(TRITON_MODELS_PAYLOAD)).toEqual(
			TRITON_MODELS_PAYLOAD.data.map((model) => ({ id: model.id, loaded: model.loaded, contextWindow: null })),
		);
	});

	it("reads a server's context window field and leaves out entries without an id", () => {
		expect(
			parseOpenAiCompatibleModels({
				data: [
					{ id: "a", max_model_len: 131072 },
					{ id: "b", context_length: 8192, loaded: "yes" },
					{ object: "model" },
				],
			}),
		).toEqual([
			{ id: "a", loaded: null, contextWindow: { tokens: 131072, field: "max_model_len" } },
			{ id: "b", loaded: null, contextWindow: { tokens: 8192, field: "context_length" } },
		]);
		expect(() => parseOpenAiCompatibleModels({ error: "nope" })).toThrow("no data array");
	});

	it("asks <baseUrl>/models, with the configured key only when the env holds it", async () => {
		const fake = createFakeOpenAiCompatibleFetch();
		const provider = tritonProvider(`${TRITON_URL}/`, { apiKeyEnv: "TRITON_KEY" });
		await fetchOpenAiCompatibleModels(provider, { fetch: fake.fetch, env: {} });
		await fetchOpenAiCompatibleModels(provider, { fetch: fake.fetch, env: { TRITON_KEY: "k" } });
		expect(fake.requests).toEqual([
			{ url: "http://triton.test/v1/models", authorization: null },
			{ url: "http://triton.test/v1/models", authorization: "Bearer k" },
		]);
		await expect(
			fetchOpenAiCompatibleModels(provider, { fetch: createFakeOpenAiCompatibleFetch(503).fetch }),
		).rejects.toThrow("HTTP 503");
	});

	it("tells loaded, loading and unknown apart", async () => {
		const { fetch } = createFakeOpenAiCompatibleFetch();
		const provider = tritonProvider(TRITON_URL);
		expect(await fetchOpenAiCompatibleModelLoaded(provider, "qwen3.6-35b-a3b", { fetch })).toBe(true);
		expect(await fetchOpenAiCompatibleModelLoaded(provider, "glm-5.3-flash", { fetch })).toBe(false);
		expect(await fetchOpenAiCompatibleModelLoaded(provider, "not-listed", { fetch })).toBeNull();
		const down = createFakeOpenAiCompatibleFetch(null).fetch;
		expect(await fetchOpenAiCompatibleModelLoaded(provider, "glm-5.3-flash", { fetch: down })).toBeNull();
	});
});

describe("provider-id rules for a configured provider", () => {
	let server: FakeOpenAiCompatibleServer | null = null;
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it("local: true prices at 0 and counts as local (no cloud QA slot); local: false doesn't", () => {
		expect(isLocalProvider("triton")).toBe(false);
		setConfiguredOpenAiCompatibleProviders({
			triton: tritonProvider(TRITON_URL),
			cloudy: tritonProvider("http://cloudy.test/v1", { local: false }),
		});
		expect(isLocalProvider("triton")).toBe(true);
		expect(isUnmeteredProvider("triton")).toBe(true);
		expect(isLocalProvider("cloudy")).toBe(false);
		const table = createPriceTable({ prices: [] }, "test");
		expect(table.priceFor("qwen3.6-35b-a3b", "triton")).toMatchObject({ in: 0, out: 0 });
		expect(table.priceFor("qwen3.6-35b-a3b", "cloudy")).toBeNull();
	});

	it("is set up by kanban setup-provider once it is in config.json", () => {
		expect(isSetupProviderId("triton")).toBe(false);
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider(TRITON_URL) });
		expect(isSetupProviderId("triton")).toBe(true);
	});

	it("has an outage probe: up while the model list answers, down while the host refuses", async () => {
		expect(canProbeProvider("triton")).toBe(false);
		const deps = { bedrock: null, lemonadeBaseUrl: "http://lemonade.test/api/v1" };
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider(await getRefusingOpenAiCompatibleBaseUrl()) });
		expect(canProbeProvider("triton")).toBe(true);
		const down = await probeModel({ provider: "triton", model: "qwen3.6-35b-a3b" }, deps);
		expect(down).toMatchObject({ kind: "health", up: false, status: null });

		server = await startFakeOpenAiCompatibleServer();
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider(server.baseUrl) });
		const up = await probeModel({ provider: "triton", model: "qwen3.6-35b-a3b" }, deps);
		expect(up).toMatchObject({ kind: "health", up: true, status: 200, detail: "lists 6 model(s)" });
		expect(server.requests).toEqual(["/v1/models"]);
	});

	it("Cline's TUI needs a stored baseUrl and model for it, as for Lemonade", () => {
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider(TRITON_URL) });
		const providers = (settings: Record<string, unknown>) => ({ providers: { triton: { settings } } });
		expect(
			describeClineTuiSignInGap(providers({ provider: "triton", model: "qwen3.6-35b-a3b" }), "triton"),
		).toContain("no baseUrl and model");
		expect(
			describeClineTuiSignInGap(
				providers({ provider: "triton", model: "qwen3.6-35b-a3b", baseUrl: TRITON_URL }),
				"triton",
			),
		).toBeNull();
		expect(describeClineTuiSignInGap({ providers: {} }, "triton")).toBe("providers.json has no triton entry");
	});

	it("reads the vendors of Triton's ids through the family table", () => {
		expect(
			Object.fromEntries(TRITON_MODELS_PAYLOAD.data.map((model) => [model.id, getModelVendor(model.id)])),
		).toEqual({
			"qwen3.6-35b-a3b": "qwen",
			"ornith-1.5-35b-a3b": "ornith",
			"qwen3-coder-next": "qwen",
			"gemma-4-26b-a4b-it": "google",
			"laguna-s-2.1": "poolside",
			"glm-5.3-flash": "zai",
		});
		expect(getModelVendor("ornith-1.5-31b")).toBe("ornith");
	});

	it("keeps a configured apiKeyEnv out of the pipeline checks' env", () => {
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider(TRITON_URL, { apiKeyEnv: "TRITON_API_KEY" }) });
		expect(listConfiguredProviderKeyEnvNames()).toEqual(["TRITON_API_KEY"]);
		const before = process.env.TRITON_API_KEY;
		process.env.TRITON_API_KEY = "secret";
		try {
			const env = createCheckStepEnv(parsePipelineConfig({}).config.pipeline.checks, "/tmp/npmrc");
			expect(env.TRITON_API_KEY).toBeUndefined();
		} finally {
			if (before === undefined) {
				delete process.env.TRITON_API_KEY;
			} else {
				process.env.TRITON_API_KEY = before;
			}
		}
	});
});
