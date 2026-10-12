// LocalAI v4.11.0's answers on the user's instance (2026-10-11), trimmed to the fields Kanban reads plus a few it
// ignores, and a fake LocalAI on a local port that serves them. "granite-embedding" is made up from the instance's
// agent-pool embedding model: a model that isn't a chat model, which the lists leave out.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const LOCALAI_MODELS_PAYLOAD = {
	object: "list",
	data: [
		{ id: "Laguna-S-2.1-Q4_K_M", object: "model" },
		{ id: "devstral-2-123b-instruct-2512-ud-q4-k-xl", object: "model" },
		{ id: "gemma-4-26b-a4b-it", object: "model" },
		{ id: "glm-5.3-flash-q2-k", object: "model" },
		{ id: "granite-embedding-107m-multilingual", object: "model" },
		{ id: "ornith-1.5-35b-a3b-apex", object: "model" },
		{ id: "qwen3-coder-next-q8-0-qwen", object: "model" },
	],
};

const text = { input_modalities: ["text"], output_modalities: ["text"] };
const vision = { input_modalities: ["text", "image"], output_modalities: ["text"] };

export const LOCALAI_CAPABILITIES_PAYLOAD = {
	object: "list",
	data: [
		{ id: "Laguna-S-2.1-Q4_K_M", object: "model", capabilities: ["chat"], ...text, context_size: 262144 },
		{
			id: "devstral-2-123b-instruct-2512-ud-q4-k-xl",
			object: "model",
			capabilities: ["chat"],
			...text,
			context_size: 262144,
		},
		{ id: "gemma-4-26b-a4b-it", object: "model", capabilities: ["chat", "vision"], ...vision, context_size: 262144 },
		{ id: "glm-5.3-flash-q2-k", object: "model", capabilities: ["chat", "vision"], ...vision, context_size: 131072 },
		{
			id: "granite-embedding-107m-multilingual",
			object: "model",
			capabilities: ["embeddings"],
			...text,
			context_size: 512,
		},
		{
			id: "ornith-1.5-35b-a3b-apex",
			object: "model",
			capabilities: ["chat", "vision", "thinking"],
			...vision,
			context_size: 262144,
		},
		{ id: "qwen3-coder-next-q8-0-qwen", object: "model", capabilities: ["chat"], ...text },
	],
};

export const LOCALAI_CHAT_MODEL_IDS = [
	"Laguna-S-2.1-Q4_K_M",
	"devstral-2-123b-instruct-2512-ud-q4-k-xl",
	"gemma-4-26b-a4b-it",
	"glm-5.3-flash-q2-k",
	"ornith-1.5-35b-a3b-apex",
	"qwen3-coder-next-q8-0-qwen",
];

export const LOCALAI_SYSTEM_PAYLOAD = {
	backends: ["llama-cpp", "vllm"],
	loaded_models: [
		{
			id: "ornith-1.5-35b-a3b-apex",
			backend: "llama-cpp",
			process: { pid: 163, rss_bytes: 10560712704, started_at: "2026-10-11T23:21:42Z" },
		},
	],
};

export const LOCALAI_SETTINGS_PAYLOAD = {
	watchdog_enabled: false,
	single_backend: true,
	max_active_backends: 1,
	threads: 24,
	context_size: -1,
};

export interface FakeLocalAiOptions {
	/** Route → JSON body, or a status code to answer with. Missing routes answer 404. */
	routes?: Record<string, unknown>;
}

export interface FakeLocalAi {
	url: string;
	/** Paths asked, in order. */
	requests: string[];
	close: () => Promise<void>;
}

/** A LocalAI on 127.0.0.1 serving the payloads above (or `routes`). */
export async function startFakeLocalAi(options: FakeLocalAiOptions = {}): Promise<FakeLocalAi> {
	const routes: Record<string, unknown> = options.routes ?? {
		"/v1/models": LOCALAI_MODELS_PAYLOAD,
		"/v1/models/capabilities": LOCALAI_CAPABILITIES_PAYLOAD,
		"/system": LOCALAI_SYSTEM_PAYLOAD,
		"/api/settings": LOCALAI_SETTINGS_PAYLOAD,
		"/readyz": 200,
	};
	const requests: string[] = [];
	const server: Server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		requests.push(path);
		const route = routes[path];
		if (route === undefined) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { code: 404, message: "Resource not found" } }));
			return;
		}
		if (typeof route === "number") {
			res.writeHead(route);
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(route));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** A URL on 127.0.0.1 nothing listens on: every connection is refused (a LocalAI host that is down). */
export async function getRefusingLocalAiUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}`;
}
