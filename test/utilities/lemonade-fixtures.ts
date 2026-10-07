// Lemonade 11.5.2's /api/v1/models, /api/v1/params and /api/v1/health on the pod (2026-10-07), trimmed to the
// fields Kanban reads plus a few it ignores. "Mystery-Coder-GGUF" is made up: a tool-calling model Lemonade has no
// context info for, and Gemma's recipe ctx_size is lowered to 65536 (live: 262144) to show the recipe beats the max.

export const LEMONADE_MODELS_PAYLOAD = {
	object: "list",
	data: [
		{
			id: "Devstral-Small-2507-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["coding", "tool-calling"],
			max_context_window: 131072,
			recipe: "llamacpp",
			recipe_options: { ctx_size: 131072, llamacpp_backend: "vulkan", merge_args: true, pinned: false },
		},
		{
			id: "Flux-2-Klein-9B-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["image", "edit"],
			recipe: "sd-cpp",
			recipe_options: { cfg_scale: 1.0, height: 256, steps: 4, width: 256 },
		},
		{
			id: "GLM-4.7-Flash-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["tool-calling"],
			max_context_window: 202752,
			recipe: "llamacpp",
			recipe_options: { ctx_size: 202752, llamacpp_backend: "vulkan", merge_args: true, pinned: false },
		},
		{
			id: "Gemma-4-12B-it-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["tool-calling", "vision", "llamacpp"],
			max_context_window: 262144,
			recipe: "llamacpp",
			recipe_options: { ctx_size: 65536, merge_args: true, pinned: false },
		},
		{
			id: "Qwen3.6-35B-A3B-MTP-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["vision", "tool-calling", "mtp"],
			max_context_window: 262144,
			recipe: "llamacpp",
			recipe_options: {},
		},
		{
			id: "gpt-oss-20b-mxfp4-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["hot", "reasoning", "tool-calling"],
			max_context_window: 131072,
			recipe: "llamacpp",
			recipe_options: {},
		},
		{
			id: "Mystery-Coder-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["tool-calling"],
			recipe: "llamacpp",
			recipe_options: { ctx_size: -1 },
		},
		{
			id: "Not-Downloaded-GGUF",
			object: "model",
			owned_by: "lemonade",
			downloaded: false,
			labels: ["tool-calling"],
			max_context_window: 32768,
		},
		{
			id: "Whisper-Large-v3-Turbo",
			object: "model",
			owned_by: "lemonade",
			downloaded: true,
			labels: ["transcription", "realtime-transcription", "hot"],
			recipe: "whispercpp",
			recipe_options: {},
		},
	],
};

/** The global ctx_size is -1: auto-tune at load time. */
export const LEMONADE_PARAMS_PAYLOAD = { ctx_size: -1, port: 13305, max_loaded_models: 1 };

export const LEMONADE_HEALTH_IDLE_PAYLOAD = { status: "ok", version: "11.5.2", all_models_loaded: [] };

/** Qwen3.6 loaded, auto-tuned below its max. */
export const LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD = {
	status: "ok",
	version: "11.5.2",
	all_models_loaded: [
		{
			model_name: "Qwen3.6-35B-A3B-MTP-GGUF",
			recipe: "llamacpp",
			recipe_options: { ctx_size: 98304, llamacpp_backend: "vulkan" },
			max_context_window: 262144,
		},
	],
};

export interface FakeLemonadeOptions {
	models?: unknown;
	params?: unknown;
	health?: unknown;
	/** Paths (relative to /api/v1) that answer HTTP 404. */
	missing?: string[];
	/** Every request fails like a refused connection. */
	down?: boolean;
}

/** A fetch that answers like Lemonade at any origin and records the URLs it was asked for. */
export function createFakeLemonadeFetch(options: FakeLemonadeOptions = {}): typeof fetch & { urls: string[] } {
	const urls: string[] = [];
	const bodies: Record<string, unknown> = {
		models: options.models ?? LEMONADE_MODELS_PAYLOAD,
		params: options.params ?? LEMONADE_PARAMS_PAYLOAD,
		health: options.health ?? LEMONADE_HEALTH_IDLE_PAYLOAD,
	};
	const fake = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		urls.push(url);
		if (options.down) {
			throw new TypeError("fetch failed");
		}
		const name = new URL(url).pathname.replace(/^.*\/api\/v1\//u, "");
		if (options.missing?.includes(name) || !(name in bodies)) {
			return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
		}
		return new Response(JSON.stringify(bodies[name]), { status: 200 });
	};
	return Object.assign(fake as typeof fetch, { urls });
}
