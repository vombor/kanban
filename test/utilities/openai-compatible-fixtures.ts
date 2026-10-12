// An OpenAI-compatible model server for tests: the user's Triton (TensorRT-LLM) router's GET /v1/models, word for word
// as it answered on 2026-10-12 (~03:47Z, after one load), and a real HTTP fake of it on 127.0.0.1. Never the network.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { OpenAiCompatibleProviderSettings } from "../../src/config/openai-compatible-providers-config";

/** Triton's router lists six models with `loaded` per model and no context window. */
export const TRITON_MODELS_PAYLOAD = {
	object: "list",
	data: [
		{ id: "qwen3.6-35b-a3b", object: "model", owned_by: "trtllm", loaded: true },
		{ id: "ornith-1.5-35b-a3b", object: "model", owned_by: "trtllm", loaded: false },
		{ id: "qwen3-coder-next", object: "model", owned_by: "trtllm", loaded: false },
		{ id: "gemma-4-26b-a4b-it", object: "model", owned_by: "trtllm", loaded: false },
		{ id: "laguna-s-2.1", object: "model", owned_by: "trtllm", loaded: false },
		{ id: "glm-5.3-flash", object: "model", owned_by: "trtllm", loaded: false },
	],
};

/** Its answer to any path it doesn't route. */
export const TRITON_UNKNOWN_PATH_BODY = {
	error: { message: "unknown path /", type: "router_error", code: 404 },
};

export function tritonProvider(baseUrl: string, overrides: Partial<OpenAiCompatibleProviderSettings> = {}) {
	return {
		name: "Triton (TensorRT-LLM)",
		baseUrl,
		local: true,
		models: {},
		...overrides,
	} satisfies OpenAiCompatibleProviderSettings;
}

export interface FakeOpenAiCompatibleFetch {
	fetch: typeof fetch;
	requests: Array<{ url: string; authorization: string | null }>;
}

/** A fetch answering `<base>/models` with `payload` (a number: that HTTP status; null: a refused connection). */
export function createFakeOpenAiCompatibleFetch(payload: unknown = TRITON_MODELS_PAYLOAD): FakeOpenAiCompatibleFetch {
	const requests: FakeOpenAiCompatibleFetch["requests"] = [];
	const fake = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		requests.push({ url, authorization: headers.get("authorization") });
		if (payload === null) {
			throw new TypeError("fetch failed: connect ECONNREFUSED");
		}
		if (typeof payload === "number") {
			return new Response(JSON.stringify(TRITON_UNKNOWN_PATH_BODY), { status: payload });
		}
		if (!new URL(url).pathname.endsWith("/models")) {
			return new Response(JSON.stringify(TRITON_UNKNOWN_PATH_BODY), { status: 404 });
		}
		return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
	};
	return { fetch: fake as typeof fetch, requests };
}

export interface FakeOpenAiCompatibleServer {
	/** The OpenAI base, `http://127.0.0.1:<port>/v1`. */
	baseUrl: string;
	requests: string[];
	close: () => Promise<void>;
}

/** Triton's router on 127.0.0.1: `/v1/models` answers, every other path is its `router_error` 404. */
export async function startFakeOpenAiCompatibleServer(
	payload: unknown = TRITON_MODELS_PAYLOAD,
): Promise<FakeOpenAiCompatibleServer> {
	const requests: string[] = [];
	const server: Server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		requests.push(path);
		res.writeHead(path === "/v1/models" ? 200 : 404, { "Content-Type": "application/json" });
		res.end(JSON.stringify(path === "/v1/models" ? payload : TRITON_UNKNOWN_PATH_BODY));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		requests,
		close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** An OpenAI base on 127.0.0.1 nothing listens on: every connection is refused (the server's host is down). */
export async function getRefusingOpenAiCompatibleBaseUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}/v1`;
}
