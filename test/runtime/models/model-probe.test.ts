import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../../../src/models/bedrock-probe";
import { buildLemonadeHealthUrl, canProbeProvider, probeModel } from "../../../src/models/model-probe";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const LEMONADE_BASE_URL = "http://localhost:13305/api/v1/";

describe("probeModel (outage recovery's probe)", () => {
	it("probes Lemonade through /health, since it has no tool-call probe", async () => {
		const fetchMock = vi.fn<FetchLike>(async () =>
			jsonResponse({ status: "ok", model_loaded: "Qwen3-Coder-Next-GGUF" }),
		);
		const outcome = await probeModel(
			{ provider: "lemonade", model: "Qwen3-Coder-Next-GGUF" },
			{ bedrock: null, lemonadeBaseUrl: LEMONADE_BASE_URL, fetch: fetchMock },
		);
		expect(outcome).toMatchObject({
			kind: "health",
			up: true,
			url: "http://localhost:13305/api/v1/health",
			status: 200,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe(buildLemonadeHealthUrl(LEMONADE_BASE_URL));
	});

	it("counts a refused Lemonade connection or a non-ok status as down", async () => {
		const refused = await probeModel(
			{ provider: "lemonade", model: "m" },
			{
				bedrock: null,
				lemonadeBaseUrl: LEMONADE_BASE_URL,
				fetch: async () => {
					throw new Error("fetch failed");
				},
			},
		);
		expect(refused).toMatchObject({ kind: "health", up: false, status: null });
		const loading = await probeModel(
			{ provider: "lemonade", model: "m" },
			{ bedrock: null, lemonadeBaseUrl: LEMONADE_BASE_URL, fetch: async () => jsonResponse({ status: "loading" }) },
		);
		expect(loading).toMatchObject({ kind: "health", up: false, detail: "status loading" });
	});

	it("sends a Bedrock card's model through its us.* profile and reports the tool call", async () => {
		const fetchMock = vi.fn<FetchLike>(async () =>
			jsonResponse({ output: { message: { content: [{ toolUse: { input: { path: "package.json" } } }] } } }),
		);
		const outcome = await probeModel(
			{ provider: "bedrock", model: "zai.glm-5" },
			{
				bedrock: { region: "us-east-1", apiKey: "k", profiles: ["us.zai.glm-5"] },
				lemonadeBaseUrl: LEMONADE_BASE_URL,
				fetch: fetchMock,
			},
		);
		expect(outcome.up).toBe(true);
		expect(outcome).toMatchObject({
			kind: "tool-call",
			result: { requestedModelId: "zai.glm-5", modelId: "us.zai.glm-5" },
		});
		expect(fetchMock.mock.calls[0]?.[0]).toContain(
			"bedrock-runtime.us-east-1.amazonaws.com/model/us.zai.glm-5/converse",
		);
	});

	it("has no probe for other providers, xAI models or a missing Bedrock key", async () => {
		const fetchMock = vi.fn<FetchLike>();
		const deps = { bedrock: null, lemonadeBaseUrl: LEMONADE_BASE_URL, fetch: fetchMock };
		await expect(probeModel({ provider: "openai-native", model: "gpt-6" }, deps)).resolves.toMatchObject({
			kind: "unsupported",
			up: false,
		});
		await expect(probeModel({ provider: null, model: "gpt-6" }, deps)).resolves.toMatchObject({
			kind: "unsupported",
		});
		await expect(probeModel({ provider: "bedrock", model: "zai.glm-5" }, deps)).resolves.toMatchObject({
			kind: "unsupported",
			reason: expect.stringContaining("API key"),
		});
		await expect(
			probeModel(
				{ provider: "bedrock", model: "xai.grok-4" },
				{ ...deps, bedrock: { region: "us-west-2", apiKey: "k", profiles: [] } },
			),
		).resolves.toMatchObject({ kind: "unsupported", reason: expect.stringContaining("xAI") });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(canProbeProvider("bedrock")).toBe(true);
		expect(canProbeProvider("lemonade")).toBe(true);
		expect(canProbeProvider("openai-native")).toBe(false);
		expect(canProbeProvider(null)).toBe(false);
	});
});
