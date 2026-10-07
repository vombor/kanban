import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LEMONADE_MODEL_LIST_SETTINGS } from "../../../src/config/model-lists-config";
import {
	createModelListsRequestHandler,
	filterLemonadeModels,
	LEMONADE_MODEL_LIST_PATH,
	type ModelListsRouteDependencies,
} from "../../../src/server/model-lists-route";

// A trimmed copy of Lemonade's /api/v1/models: coding models next to image, speech and TTS ones.
const LEMONADE_MODELS = {
	object: "list",
	data: [
		{ id: "Qwen3-Coder-Next-GGUF", owned_by: "lemonade", labels: ["coding", "tool-calling"], downloaded: true },
		{ id: "gpt-oss-20b-mxfp4-GGUF", labels: ["reasoning", "tool-calling"] },
		{ id: "Gemma-4-12B-it-GGUF", labels: ["vision"], downloaded: true },
		{ id: "Flux-2-Klein-4B", labels: ["image"], downloaded: true },
		{ id: "Whisper-Large-v3-Turbo", labels: ["audio", "transcription"], downloaded: true },
		{ id: "kokoro-v1", labels: ["tts"], downloaded: true },
		{ id: "Qwen3.6-35B-A3B-MTP-GGUF", labels: ["tool-calling"], downloaded: false },
		{ name: "not a model" },
	],
};

describe("filterLemonadeModels", () => {
	it("keeps only downloaded models with every required label, in Cline's list shape", () => {
		expect(filterLemonadeModels(LEMONADE_MODELS, ["tool-calling"])).toEqual({
			object: "list",
			data: [
				{
					id: "Qwen3-Coder-Next-GGUF",
					object: "model",
					owned_by: "lemonade",
					labels: ["coding", "tool-calling"],
				},
				{
					id: "gpt-oss-20b-mxfp4-GGUF",
					object: "model",
					owned_by: "lemonade",
					labels: ["reasoning", "tool-calling"],
				},
			],
		});
		expect(filterLemonadeModels(LEMONADE_MODELS, ["tool-calling", "coding"]).data.map((model) => model.id)).toEqual([
			"Qwen3-Coder-Next-GGUF",
		]);
	});

	it("treats a response without data as an empty list", () => {
		expect(filterLemonadeModels({}, ["tool-calling"])).toEqual({ object: "list", data: [] });
	});
});

describe("model-lists route", () => {
	let server: Server | null = null;

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = null;
	});

	async function serve(deps: ModelListsRouteDependencies): Promise<string> {
		const handle = createModelListsRequestHandler(deps);
		server = createServer(async (req, res) => {
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			if (!(await handle(req, res, pathname))) {
				res.writeHead(418);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	function lemonadeFetch(response: () => Response): ModelListsRouteDependencies["fetch"] {
		return vi.fn(async () => response()) as unknown as typeof fetch;
	}

	it("serves Lemonade's filtered list from the configured URL", async () => {
		const fetchImpl = lemonadeFetch(() => Response.json(LEMONADE_MODELS));
		const origin = await serve({
			loadLemonadeSettings: async () => ({ url: "http://lemonade.test:13305/", requireLabels: ["tool-calling"] }),
			fetch: fetchImpl,
			warn: vi.fn(),
		});

		const response = await fetch(`${origin}${LEMONADE_MODEL_LIST_PATH}`);

		expect(response.status).toBe(200);
		expect(((await response.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id)).toEqual([
			"Qwen3-Coder-Next-GGUF",
			"gpt-oss-20b-mxfp4-GGUF",
		]);
		expect(fetchImpl).toHaveBeenCalledWith("http://lemonade.test:13305/api/v1/models", expect.anything());
		// A trailing slash is the same route.
		expect((await fetch(`${origin}${LEMONADE_MODEL_LIST_PATH}/`)).status).toBe(200);
	});

	it("returns 502 when Lemonade fails, so Cline keeps its static list, and logs each distinct error once", async () => {
		const warn = vi.fn();
		const origin = await serve({
			loadLemonadeSettings: async () => DEFAULT_LEMONADE_MODEL_LIST_SETTINGS,
			fetch: lemonadeFetch(() => new Response("down", { status: 503 })),
			warn,
		});

		const first = await fetch(`${origin}${LEMONADE_MODEL_LIST_PATH}`);
		await fetch(`${origin}${LEMONADE_MODEL_LIST_PATH}`);

		expect(first.status).toBe(502);
		expect(await first.json()).toEqual({ error: "lemonade HTTP 503" });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("lemonade HTTP 503");
	});

	it("rejects other methods and leaves other paths to the caller", async () => {
		const fetchImpl = lemonadeFetch(() => Response.json(LEMONADE_MODELS));
		const origin = await serve({
			loadLemonadeSettings: async () => DEFAULT_LEMONADE_MODEL_LIST_SETTINGS,
			fetch: fetchImpl,
			warn: vi.fn(),
		});

		const post = await fetch(`${origin}${LEMONADE_MODEL_LIST_PATH}`, { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
		expect((await fetch(`${origin}/api/model-lists/openai`)).status).toBe(418);
		expect((await fetch(`${origin}${LEMONADE_MODEL_LIST_PATH}/models`)).status).toBe(418);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
