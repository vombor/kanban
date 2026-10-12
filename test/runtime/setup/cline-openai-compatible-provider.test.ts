// `kanban setup-provider <id>` for an OpenAI-compatible provider (src/setup/cline-openai-compatible-provider.ts): Cline's
// two entries from config.json and the server's model list, the orchestrator's models.json list left as it is (no model
// added, no modelsSourceUrl), metadata filled in, backups, refusals and the doctor row. Temp dirs and a fake fetch only.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OpenAiCompatibleProviderSettings } from "../../../src/config/openai-compatible-providers-config";
import { checkOpenAiCompatibleProvider } from "../../../src/doctor/openai-compatible-provider-checks";
import { setConfiguredOpenAiCompatibleProviders } from "../../../src/models/openai-compatible-providers";
import {
	applyClineOpenAiCompatibleProvider,
	planClineOpenAiCompatibleProvider,
} from "../../../src/setup/cline-openai-compatible-provider";
import { describeClineTuiSignInGap } from "../../../src/terminal/cline-tui-sign-in";
import { createFakeOpenAiCompatibleFetch, tritonProvider } from "../../utilities/openai-compatible-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const BASE_URL = "http://triton.test/v1";
const NOW = new Date("2026-10-12T12:00:00.000Z");

describe("setup-provider for an OpenAI-compatible provider", () => {
	let root: { path: string; cleanup: () => void };
	let modelsPath: string;
	let providersPath: string;
	let backupDir: string;

	beforeEach(() => {
		root = createTempDir("kanban-openai-compatible-setup-");
		modelsPath = join(root.path, "data", "settings", "models.json");
		providersPath = join(root.path, "data", "settings", "providers.json");
		backupDir = join(root.path, "home", "backups", "cline");
	});

	afterEach(() => {
		setConfiguredOpenAiCompatibleProviders({});
		root.cleanup();
	});

	function writeJson(path: string, document: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
	}

	function readJson(path: string) {
		return JSON.parse(readFileSync(path, "utf8"));
	}

	function options(
		provider: OpenAiCompatibleProviderSettings = tritonProvider(BASE_URL),
		extra: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; dryRun?: boolean } = {},
	) {
		setConfiguredOpenAiCompatibleProviders({ triton: provider });
		return {
			providerId: "triton",
			provider,
			modelsPath,
			providersPath,
			env: extra.env ?? {},
			fetch: extra.fetch ?? createFakeOpenAiCompatibleFetch().fetch,
			backupDir,
			dryRun: extra.dryRun ?? false,
			now: NOW,
		};
	}

	/** models.json as the orchestrator curates it: other providers, and the triton models cards may use. */
	function writeCuratedModels(models: Record<string, unknown>, provider: Record<string, unknown> = {}): void {
		writeJson(modelsPath, {
			version: 1,
			providers: {
				lemonade: { provider: { name: "Lemonade", baseUrl: "http://localhost:13305/api/v1" }, models: {} },
				triton: { provider: { name: "Old name", baseUrl: "http://old.test/v1", ...provider }, models },
			},
		});
	}

	it("sets up a provider Cline doesn't have yet, adds no model, and says the TUI still needs one", async () => {
		const result = await applyClineOpenAiCompatibleProvider(options());
		expect(result.status).toBe("written");
		const entry = readJson(modelsPath).providers.triton;
		expect(entry).toEqual({
			provider: {
				name: "Triton (TensorRT-LLM)",
				baseUrl: BASE_URL,
				protocol: "openai-chat",
				capabilities: ["tools"],
			},
			models: {},
		});
		expect(entry.provider.modelsSourceUrl).toBeUndefined();
		const settings = readJson(providersPath).providers.triton.settings;
		expect(settings).toEqual({ provider: "triton", baseUrl: BASE_URL });
		expect(describeClineTuiSignInGap(readJson(providersPath), "triton")).toContain("no baseUrl and model");
		expect(result.lines.join("\n")).toContain("the orchestrator adds a model to models.json");
		expect(result.lines.join("\n")).toContain("the server also lists qwen3.6-35b-a3b, ornith-1.5-35b-a3b");
		// New files are private, like Cline's own; there is nothing to back up.
		expect(statSync(providersPath).mode & 0o777).toBe(0o600);
		expect(result.backupPaths).toEqual([]);
		expect(result.rollback).toBe(`rm '${modelsPath}' && rm '${providersPath}'`);
	});

	it("fills in the curated models' metadata (config, else default) and stores a model; never adds the server's others", async () => {
		writeCuratedModels({
			"qwen3.6-35b-a3b": { id: "qwen3.6-35b-a3b", name: "Qwen 3.6", supportsReasoning: true },
			"glm-5.3-flash": { id: "glm-5.3-flash" },
		});
		writeJson(providersPath, {
			version: 1,
			lastUsedProvider: "bedrock",
			providers: { bedrock: { settings: { provider: "bedrock", apiKey: "bedrock-key" } } },
		});
		const provider = tritonProvider(BASE_URL, { models: { "glm-5.3-flash": { contextWindow: 131072 } } });
		const result = await applyClineOpenAiCompatibleProvider(options(provider));
		expect(result.status).toBe("written");

		const entry = readJson(modelsPath).providers.triton;
		expect(Object.keys(entry.models)).toEqual(["qwen3.6-35b-a3b", "glm-5.3-flash"]);
		expect(entry.models["qwen3.6-35b-a3b"]).toEqual({
			id: "qwen3.6-35b-a3b",
			name: "Qwen 3.6",
			supportsReasoning: true,
			contextWindow: 32768,
			maxTokens: 8192,
			inputPrice: 0,
			outputPrice: 0,
		});
		expect(entry.models["glm-5.3-flash"]).toMatchObject({ contextWindow: 131072, maxTokens: 32768 });
		expect(entry.provider).toEqual({
			name: "Triton (TensorRT-LLM)",
			baseUrl: BASE_URL,
			defaultModelId: "qwen3.6-35b-a3b",
			protocol: "openai-chat",
		});
		expect(readJson(modelsPath).providers.lemonade.provider.name).toBe("Lemonade");

		const document = readJson(providersPath);
		expect(document.providers.triton.settings).toEqual({
			provider: "triton",
			model: "qwen3.6-35b-a3b",
			baseUrl: BASE_URL,
		});
		expect(document.providers.triton).toMatchObject({ updatedAt: NOW.toISOString(), tokenSource: "manual" });
		expect(document.lastUsedProvider).toBe("bedrock");
		expect(document.providers.bedrock.settings.apiKey).toBe("bedrock-key");
		expect(describeClineTuiSignInGap(document, "triton")).toBeNull();

		const lines = result.lines.join("\n");
		expect(lines).toContain("the server reports none: Kanban's default 32768");
		expect(lines).toContain("providers.openaiCompatible.triton.models in config.json");
		expect(readdirSync(backupDir)).toHaveLength(2);
		expect(result.rollback).toContain("cp ");

		const again = await applyClineOpenAiCompatibleProvider(options(provider));
		expect(again.status).toBe("in-sync");
	});

	it("keeps a window the orchestrator set and a model it picked, and drops a modelsSourceUrl", async () => {
		writeCuratedModels(
			{
				"qwen3-coder-next": { id: "qwen3-coder-next", contextWindow: 65536, maxTokens: 4096 },
				"laguna-s-2.1": {
					id: "laguna-s-2.1",
					contextWindow: 65536,
					maxTokens: 4096,
					inputPrice: 0,
					outputPrice: 0,
				},
			},
			{ modelsSourceUrl: "http://elsewhere.test/models", defaultModelId: "laguna-s-2.1" },
		);
		writeJson(providersPath, {
			version: 1,
			providers: { triton: { settings: { provider: "triton", model: "laguna-s-2.1", baseUrl: BASE_URL } } },
		});
		await applyClineOpenAiCompatibleProvider(options());
		const entry = readJson(modelsPath).providers.triton;
		expect(entry.models["qwen3-coder-next"]).toMatchObject({ contextWindow: 65536, maxTokens: 4096, inputPrice: 0 });
		expect(entry.provider).toMatchObject({ defaultModelId: "laguna-s-2.1" });
		expect(entry.provider.modelsSourceUrl).toBeUndefined();
		expect(readJson(providersPath).providers.triton.settings.model).toBe("laguna-s-2.1");
	});

	it("takes a window the server reports, and notes curated models the server doesn't list", async () => {
		writeCuratedModels({ big: { id: "big" }, gone: { id: "gone", contextWindow: 4096 } });
		const fetch = createFakeOpenAiCompatibleFetch({ data: [{ id: "big", max_model_len: 262144 }] }).fetch;
		const result = await applyClineOpenAiCompatibleProvider(options(tritonProvider(BASE_URL), { fetch }));
		const models = readJson(modelsPath).providers.triton.models;
		expect(models.big).toMatchObject({ contextWindow: 262144, maxTokens: 32768 });
		expect(models.gone).toMatchObject({ contextWindow: 4096 });
		expect(result.lines.join("\n")).toContain("the server's max_model_len");
		expect(result.lines.join("\n")).toContain("the server doesn't list gone (kept in models.json");
	});

	it("with the server down applies only the config's windows and still sets the provider up", async () => {
		writeCuratedModels({ a: { id: "a" }, b: { id: "b" } });
		const provider = tritonProvider(BASE_URL, { models: { b: { contextWindow: 16384, maxTokens: 2048 } } });
		const fetch = createFakeOpenAiCompatibleFetch(null).fetch;
		const result = await applyClineOpenAiCompatibleProvider(options(provider, { fetch }));
		expect(result.status).toBe("written");
		const models = readJson(modelsPath).providers.triton.models;
		expect(models.a.contextWindow).toBeUndefined();
		expect(models.b).toMatchObject({ contextWindow: 16384, maxTokens: 2048 });
		expect(result.lines[0]).toBe('models.json provider.name: "Old name" -> "Triton (TensorRT-LLM)"');
		expect(result.lines.join("\n")).toContain("did not answer");
	});

	it("dry run writes nothing; an edit made meanwhile is never overwritten", async () => {
		writeCuratedModels({ a: { id: "a" } });
		const before = readFileSync(modelsPath, "utf8");
		const dry = await applyClineOpenAiCompatibleProvider(options(undefined, { dryRun: true }));
		expect(dry.status).toBe("would-write");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);

		const slow: typeof fetch = async (input, init) => {
			writeFileSync(modelsPath, `${before}\n`);
			return await createFakeOpenAiCompatibleFetch().fetch(input, init);
		};
		const raced = await applyClineOpenAiCompatibleProvider(options(undefined, { fetch: slow }));
		expect(raced.status).toBe("error");
		expect(raced.lines.at(-1)).toContain("changed while the server was asked");
	});

	it("stores the key from apiKeyEnv without printing it, and refuses without it", async () => {
		writeCuratedModels({ a: { id: "a" } });
		const provider = tritonProvider(BASE_URL, { apiKeyEnv: "TRITON_API_KEY" });
		const refused = await applyClineOpenAiCompatibleProvider(options(provider));
		expect(refused.status).toBe("refused");
		expect(refused.lines[0]).toContain("TRITON_API_KEY");

		const fake = createFakeOpenAiCompatibleFetch();
		const env = { TRITON_API_KEY: "the-secret-key" };
		const written = await applyClineOpenAiCompatibleProvider(options(provider, { env, fetch: fake.fetch }));
		expect(written.status).toBe("written");
		expect(written.lines.join("\n")).not.toContain("the-secret-key");
		expect(written.lines.join("\n")).toContain("providers.json settings.apiKey: (unset) -> (a key)");
		expect(readJson(providersPath).providers.triton.settings.apiKey).toBe("the-secret-key");
		expect(fake.requests[0]?.authorization).toBe("Bearer the-secret-key");
	});

	it("leaves an unreadable file alone", async () => {
		mkdirSync(dirname(modelsPath), { recursive: true });
		writeFileSync(modelsPath, "{ nope");
		const result = await applyClineOpenAiCompatibleProvider(options());
		expect(result.status).toBe("error");
		expect(readFileSync(modelsPath, "utf8")).toBe("{ nope");
		const plan = await planClineOpenAiCompatibleProvider(options());
		expect(plan.kind).toBe("error");
	});

	describe("doctor row", () => {
		const check = async (fetch: typeof globalThis.fetch = createFakeOpenAiCompatibleFetch().fetch) =>
			await checkOpenAiCompatibleProvider({ ...options(), fetch });

		it("warns with the command when Cline has no entry, then passes once written", async () => {
			const missing = await check();
			expect(missing[0]).toMatchObject({ level: "warn", hint: "kanban setup-provider triton" });
			expect(missing[0]?.message).toContain("not set up in Cline");

			writeCuratedModels({ "qwen3.6-35b-a3b": { id: "qwen3.6-35b-a3b" } });
			const differs = await check();
			expect(differs.every((finding) => finding.level === "warn")).toBe(true);
			expect(differs.some((finding) => finding.message.includes("provider.baseUrl"))).toBe(true);

			await applyClineOpenAiCompatibleProvider(options());
			const ok = await check();
			expect(ok).toEqual([expect.objectContaining({ level: "pass" })]);
			const down = await check(createFakeOpenAiCompatibleFetch(null).fetch);
			expect(down.map((finding) => finding.level)).toEqual(["info"]);
		});

		it("warns about the sign-in screen while the entry has no model", async () => {
			await applyClineOpenAiCompatibleProvider(options());
			const findings = await check();
			expect(findings).toEqual([
				expect.objectContaining({ level: "warn", message: expect.stringContaining("sign-in screen") }),
			]);
		});
	});
});
