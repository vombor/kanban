import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type FetchLike,
	isNeverProbedModel,
	loadBedrockInferenceProfiles,
	probeBedrockModel,
	resolveBedrockApiKey,
	resolveBedrockInferenceProfile,
} from "../../../src/models/bedrock-probe";
import { createTempDir } from "../../utilities/temp-dir";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const TOOL_CALL_BODY = {
	output: {
		message: { content: [{ text: "" }, { toolUse: { name: "read_file", input: { path: "package.json" } } }] },
	},
	stopReason: "tool_use",
};

describe("Bedrock probe", () => {
	it("uses the us.* inference profile only when Bedrock lists one", () => {
		const profiles = ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "eu.qwen.qwen3-coder-30b-a3b-v1:0"];
		expect(resolveBedrockInferenceProfile("anthropic.claude-haiku-4-5-20251001-v1:0", profiles)).toBe(
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		);
		// US profiles only: an eu.* profile is not used.
		expect(resolveBedrockInferenceProfile("qwen.qwen3-coder-30b-a3b-v1:0", profiles)).toBe(
			"qwen.qwen3-coder-30b-a3b-v1:0",
		);
		expect(resolveBedrockInferenceProfile("us.openai.gpt-6.1-sol", profiles)).toBe("us.openai.gpt-6.1-sol");
	});

	it("never probes xAI models", () => {
		expect(isNeverProbedModel("xai.grok-4")).toBe(true);
		expect(isNeverProbedModel("us.xai.grok-code-fast-1")).toBe(true);
		expect(isNeverProbedModel("anthropic.claude-sonnet-5")).toBe(false);
	});

	it("reports a tool call from Converse", async () => {
		const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(TOOL_CALL_BODY));
		let clock = 1_000;
		const result = await probeBedrockModel(
			{ region: "us-west-2", apiKey: "test-key", fetch: fetchMock },
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
			{
				requestedModelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
				now: () => {
					clock += 250;
					return clock;
				},
			},
		);
		expect(result).toEqual({
			requestedModelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
			modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
			status: 200,
			toolCall: true,
			detail: 'TOOL {"path":"package.json"}',
			elapsedMs: 250,
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse",
		);
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
		const body = JSON.parse(String(init?.body)) as { toolConfig: { tools: Array<{ toolSpec: { name: string } }> } };
		expect(body.toolConfig.tools[0]?.toolSpec.name).toBe("read_file");
	});

	it("reports no tool call on an error status or a text answer", async () => {
		const outage = await probeBedrockModel(
			{
				region: "us-west-2",
				apiKey: "k",
				fetch: async () => jsonResponse({ message: "Service temporarily unavailable" }, 503),
			},
			"moonshotai.kimi-k3",
		);
		expect(outage).toMatchObject({ status: 503, toolCall: false, detail: "Service temporarily unavailable" });

		const text = await probeBedrockModel(
			{
				region: "us-west-2",
				apiKey: "k",
				fetch: async () =>
					jsonResponse({ output: { message: { content: [{ text: "hi" }] } }, stopReason: "end_turn" }),
			},
			"zai.glm-5",
		);
		expect(text).toMatchObject({ status: 200, toolCall: false, detail: "end_turn" });
	});

	it("never throws on a request error", async () => {
		const result = await probeBedrockModel(
			{
				region: "us-west-2",
				apiKey: "k",
				fetch: async () => {
					throw new Error("connect ECONNREFUSED");
				},
			},
			"zai.glm-5",
		);
		expect(result).toMatchObject({ status: null, toolCall: false, detail: "connect ECONNREFUSED" });
	});

	it("takes the API key from BEDROCK_API_KEY, else Cline's bedrock provider", () => {
		const providersJson = { providers: { bedrock: { settings: { apiKey: " from-file " } } } };
		expect(resolveBedrockApiKey(providersJson, { BEDROCK_API_KEY: "from-env" })).toBe("from-env");
		expect(resolveBedrockApiKey(providersJson, {})).toBe("from-file");
		expect(resolveBedrockApiKey({ providers: { lemonade: { settings: {} } } }, {})).toBeNull();
		expect(resolveBedrockApiKey(null, {})).toBeNull();
	});

	describe("inference-profile cache", () => {
		let dir: { path: string; cleanup: () => void };
		let cachePath: string;

		beforeEach(() => {
			dir = createTempDir("kanban-bedrock-profiles-");
			cachePath = join(dir.path, "data", "models", "bedrock-profiles.json");
		});

		afterEach(() => {
			dir.cleanup();
		});

		const listing = {
			inferenceProfileSummaries: [
				{ inferenceProfileId: "us.zai.glm-5" },
				{ inferenceProfileId: "us.deepseek.v3.2" },
			],
		};

		it("fetches once, then reads the cache until --refresh", async () => {
			const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(listing));
			const endpoint = { region: "us-west-2", apiKey: "k", fetch: fetchMock };
			const first = await loadBedrockInferenceProfiles(endpoint, {
				cachePath,
				refresh: false,
				now: new Date("2026-10-07T00:00:00Z"),
			});
			expect(first).toEqual({ profiles: ["us.zai.glm-5", "us.deepseek.v3.2"], source: "bedrock", warning: null });
			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				"https://bedrock.us-west-2.amazonaws.com/inference-profiles?maxResults=1000",
			);
			expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
				fetchedAt: "2026-10-07T00:00:00.000Z",
				profiles: ["us.zai.glm-5", "us.deepseek.v3.2"],
			});

			const second = await loadBedrockInferenceProfiles(endpoint, { cachePath, refresh: false });
			expect(second.source).toBe("cache");
			expect(fetchMock).toHaveBeenCalledTimes(1);

			await loadBedrockInferenceProfiles(endpoint, { cachePath, refresh: true });
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("warns and keeps the old cache when the listing fails", async () => {
			const endpoint = {
				region: "us-west-2",
				apiKey: "k",
				fetch: async () => jsonResponse({ message: "denied" }, 403),
			};
			const missing = await loadBedrockInferenceProfiles(endpoint, { cachePath, refresh: false });
			expect(missing).toMatchObject({ profiles: [], source: "none" });
			expect(missing.warning).toContain("HTTP 403");
			expect(existsSync(cachePath)).toBe(false);

			await loadBedrockInferenceProfiles(
				{ region: "us-west-2", apiKey: "k", fetch: async () => jsonResponse(listing) },
				{ cachePath, refresh: false },
			);
			writeFileSync(cachePath, JSON.stringify({ fetchedAt: "x", profiles: ["us.cached"] }));
			const refreshed = await loadBedrockInferenceProfiles(endpoint, { cachePath, refresh: true });
			expect(refreshed.source).toBe("none");
			expect(JSON.parse(readFileSync(cachePath, "utf8")).profiles).toEqual(["us.cached"]);
		});
	});
});
