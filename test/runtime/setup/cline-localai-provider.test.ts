import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	applyClineLocalAiProvider,
	formatApplyLocalAiProviderCommand,
	planClineLocalAiProvider,
} from "../../../src/setup/cline-localai-provider";
import { describeClineTuiSignInGap } from "../../../src/terminal/cline-tui-sign-in";
import {
	type FakeLocalAi,
	getRefusingLocalAiUrl,
	LOCALAI_CHAT_MODEL_IDS,
	startFakeLocalAi,
} from "../../utilities/localai-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const ORIGIN = "http://127.0.0.1:3485";
const SOURCE_URL = `${ORIGIN}/api/model-lists/localai`;
const NOW = new Date("2026-10-11T23:30:00.000Z");

type ProviderEntry = { provider: Record<string, unknown>; models: Record<string, Record<string, unknown>> };
type ModelsDocument = { version: number; providers: Record<string, ProviderEntry>; unrelatedTopLevel?: unknown };

const LEMONADE_ENTRY = {
	provider: {
		name: "Lemonade (local)",
		baseUrl: "http://localhost:13305/api/v1",
		modelsSourceUrl: `${ORIGIN}/api/model-lists/lemonade`,
		protocol: "openai-chat",
	},
	models: { "GLM-4.7-Flash-GGUF": { id: "GLM-4.7-Flash-GGUF", contextWindow: 202752 } },
};

describe("kanban cline apply-localai-provider", () => {
	let root: { path: string; cleanup: () => void };
	let modelsPath: string;
	let providersPath: string;
	let backupDir: string;
	let localai: FakeLocalAi;

	beforeEach(async () => {
		// Never the real ~/.cline: a temp models.json, passed explicitly.
		root = createTempDir("kanban-cline-localai-");
		modelsPath = join(root.path, "cline", "data", "settings", "models.json");
		providersPath = join(root.path, "cline", "data", "settings", "providers.json");
		backupDir = join(root.path, "kanban-home", "backups", "cline");
		localai = await startFakeLocalAi();
	});

	afterEach(async () => {
		await localai.close();
		root.cleanup();
	});

	function write(document: unknown): string {
		mkdirSync(join(root.path, "cline", "data", "settings"), { recursive: true });
		const raw = `${JSON.stringify(document, null, 2)}\n`;
		writeFileSync(modelsPath, raw, { mode: 0o640 });
		return raw;
	}

	function read(): ModelsDocument {
		return JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsDocument;
	}

	function readProviders(): { lastUsedProvider?: string; providers: Record<string, Record<string, unknown>> } {
		return JSON.parse(readFileSync(providersPath, "utf8"));
	}

	function options(overrides: { baseUrl?: string; dryRun?: boolean } = {}) {
		return {
			modelsPath,
			providersPath,
			baseUrl: overrides.baseUrl ?? localai.url,
			origin: ORIGIN,
			requireCapabilities: ["chat"],
			backupDir,
			dryRun: overrides.dryRun ?? false,
			now: NOW,
		};
	}

	it("prints the user's command line with the root URL and the server origin", () => {
		expect(
			formatApplyLocalAiProviderCommand({ baseUrl: "http://localai.test/v1/", origin: "http://127.0.0.1:3485/x" }),
		).toBe("kanban cline apply-localai-provider --base-url http://localai.test --origin http://127.0.0.1:3485");
	});

	it("adds the provider to an existing models.json with a backup, touching nothing else", async () => {
		const raw = write({ version: 1, providers: { lemonade: LEMONADE_ENTRY }, unrelatedTopLevel: { keep: true } });
		const providersRaw = `${JSON.stringify({
			version: 1,
			lastUsedProvider: "bedrock",
			modes: {},
			providers: { bedrock: { settings: { provider: "bedrock", apiKey: "secret" }, tokenSource: "manual" } },
		})}\n`;
		writeFileSync(providersPath, providersRaw, { mode: 0o600 });

		const dry = await applyClineLocalAiProvider(options({ dryRun: true }));
		expect(dry.status).toBe("would-write");
		expect(readFileSync(modelsPath, "utf8")).toBe(raw);
		expect(readFileSync(providersPath, "utf8")).toBe(providersRaw);

		const result = await applyClineLocalAiProvider(options());
		expect(result.status).toBe("written");
		expect(result.lines[0]).toContain('No "localai" provider in it.');
		const document = read();
		expect(document.providers.lemonade).toEqual(LEMONADE_ENTRY);
		expect(document.unrelatedTopLevel).toEqual({ keep: true });
		expect(document.version).toBe(1);
		const entry = document.providers.localai as ProviderEntry;
		expect(entry.provider).toEqual({
			name: "LocalAI",
			baseUrl: `${localai.url}/v1`,
			modelsSourceUrl: SOURCE_URL,
			defaultModelId: "Laguna-S-2.1-Q4_K_M",
			protocol: "openai-chat",
			capabilities: ["tools"],
		});
		// Only chat models; the embedding model stays out, as on the route.
		expect(Object.keys(entry.models)).toEqual(LOCALAI_CHAT_MODEL_IDS);
		expect(entry.models["ornith-1.5-35b-a3b-apex"]).toEqual({
			id: "ornith-1.5-35b-a3b-apex",
			name: "ornith-1.5-35b-a3b-apex",
			contextWindow: 262144,
			maxTokens: 32768,
			supportsVision: true,
			supportsReasoning: true,
			inputPrice: 0,
			outputPrice: 0,
		});
		expect(entry.models["glm-5.3-flash-q2-k"]).toMatchObject({ contextWindow: 131072, supportsReasoning: false });
		// No context_size from LocalAI: no window written, Cline keeps its default.
		expect(entry.models["qwen3-coder-next-q8-0-qwen"]).not.toHaveProperty("contextWindow");
		// The file keeps its mode, and the backup is the file as read, private.
		expect(statSync(modelsPath).mode & 0o777).toBe(0o640);
		expect(result.backupPaths).toEqual([
			join(backupDir, "models.json.20261011T233000Z"),
			join(backupDir, "providers.json.20261011T233000Z"),
		]);
		expect(readFileSync(result.backupPaths[0] as string, "utf8")).toBe(raw);
		expect(readFileSync(result.backupPaths[1] as string, "utf8")).toBe(providersRaw);
		expect(statSync(result.backupPaths[0] as string).mode & 0o777).toBe(0o600);
		// providers.json: the settings Cline's TUI needs, and nothing else changed (the default provider stays).
		const providers = readProviders();
		expect(providers.lastUsedProvider).toBe("bedrock");
		expect(providers.providers.bedrock).toEqual({
			settings: { provider: "bedrock", apiKey: "secret" },
			tokenSource: "manual",
		});
		expect(providers.providers.localai).toEqual({
			settings: { provider: "localai", model: "Laguna-S-2.1-Q4_K_M", baseUrl: `${localai.url}/v1` },
			updatedAt: NOW.toISOString(),
			tokenSource: "manual",
		});
		expect(describeClineTuiSignInGap(providers, "localai")).toBeNull();

		// A second run has nothing to do.
		const again = await applyClineLocalAiProvider(options());
		expect(again.status).toBe("in-sync");
		expect(again.lines).toEqual(["provider and 6 model(s) in sync"]);
		expect(readdirSync(backupDir)).toHaveLength(2);
	});

	it("creates models.json and providers.json, private, when Cline has neither", async () => {
		const result = await applyClineLocalAiProvider(options());
		expect(result).toMatchObject({ status: "written", backupPaths: [] });
		expect(read().version).toBe(1);
		expect(Object.keys(read().providers)).toEqual(["localai"]);
		expect(statSync(modelsPath).mode & 0o777).toBe(0o600);
		expect(readProviders()).toMatchObject({
			version: 1,
			modes: {},
			providers: { localai: { tokenSource: "manual" } },
		});
		expect(statSync(providersPath).mode & 0o777).toBe(0o600);
	});

	it("keeps what Cline's model picker adds and drops, and a stored model LocalAI still lists", async () => {
		await applyClineLocalAiProvider(options());
		// The picker's rewrite (cline 3.0.70, 2026-10-11): client and discoveredModelIds added, capabilities dropped.
		const picked = read();
		const entry = picked.providers.localai as ProviderEntry & { discoveredModelIds?: string[] };
		entry.provider.client = "openai-compatible";
		delete entry.provider.capabilities;
		entry.discoveredModelIds = LOCALAI_CHAT_MODEL_IDS;
		write(picked);
		const providers = readProviders();
		(providers.providers.localai as { settings: Record<string, unknown> }).settings = {
			provider: "localai",
			model: "gemma-4-26b-a4b-it",
			baseUrl: `${localai.url}/v1`,
			protocol: "openai-chat",
			client: "openai-compatible",
		};
		writeFileSync(providersPath, JSON.stringify(providers));
		expect(await planClineLocalAiProvider(options())).toMatchObject({ inSync: true });
		expect(await applyClineLocalAiProvider(options())).toMatchObject({ status: "in-sync" });
	});

	it("shows the differences and keeps the user's own keys, models and custom source URL", async () => {
		write({
			version: 1,
			providers: {
				localai: {
					provider: {
						name: "My LocalAI",
						baseUrl: "http://old-host.test/v1",
						modelsSourceUrl: "http://127.0.0.1:9999/api/model-lists/localai",
						defaultModelId: "gemma-4-26b-a4b-it",
						protocol: "openai-chat",
						capabilities: ["tools", "images"],
						headers: { "X-Team": "kanban" },
					},
					models: {
						"gemma-4-26b-a4b-it": {
							id: "gemma-4-26b-a4b-it",
							name: "Gemma",
							contextWindow: 8192,
							temperature: 0.3,
						},
						"gone-model": { id: "gone-model", name: "gone-model" },
					},
				},
			},
		});
		const plan = await planClineLocalAiProvider(options());
		expect(plan.kind).toBe("found");
		expect(plan.details).toEqual(
			expect.arrayContaining([
				`models.json provider.baseUrl: "http://old-host.test/v1" -> "${localai.url}/v1"`,
				// Another Kanban origin's route is Kanban's to repoint.
				`models.json provider.modelsSourceUrl: "http://127.0.0.1:9999/api/model-lists/localai" -> "${SOURCE_URL}"`,
				expect.stringContaining("model gemma-4-26b-a4b-it: contextWindow 8192 -> 262144"),
				"model gone-model: remove (LocalAI no longer lists it)",
			]),
		);
		await applyClineLocalAiProvider(options());
		const entry = read().providers.localai as ProviderEntry;
		expect(entry.provider).toMatchObject({
			name: "My LocalAI",
			defaultModelId: "gemma-4-26b-a4b-it",
			capabilities: ["tools", "images"],
			headers: { "X-Team": "kanban" },
		});
		expect(entry.models["gemma-4-26b-a4b-it"]).toMatchObject({
			name: "Gemma",
			temperature: 0.3,
			contextWindow: 262144,
		});
		expect(entry.models).not.toHaveProperty("gone-model");

		// A source URL the user chose for something else stays.
		const custom = read();
		(custom.providers.localai as ProviderEntry).provider.modelsSourceUrl = "http://lists.test/mine";
		write(custom);
		expect((await planClineLocalAiProvider(options())).inSync).toBe(true);
	});

	it("with LocalAI down: adds nothing new, and changes no model of an existing entry", async () => {
		const refusing = await getRefusingLocalAiUrl();
		const absent = await applyClineLocalAiProvider(options({ baseUrl: refusing }));
		expect(absent.status).toBe("error");
		expect(absent.lines.join("\n")).toContain("did not answer");
		expect(() => statSync(modelsPath)).toThrow();

		await applyClineLocalAiProvider(options());
		const before = read().providers.localai as ProviderEntry;
		const plan = await planClineLocalAiProvider(options({ baseUrl: refusing }));
		expect(plan.unreachable).toContain(`LocalAI at ${refusing}/v1 did not answer`);
		expect(plan.entry?.models).toEqual(before.models);
		expect(plan.unreachable).not.toBeNull();
	});

	it("never overwrites an edit made while LocalAI was asked", async () => {
		write({ version: 1, providers: {} });
		// The user edits the file while LocalAI is asked: a fetch that edits it before answering.
		const editingFetch: typeof fetch = async (input, init) => {
			writeFileSync(modelsPath, `${JSON.stringify({ version: 1, providers: { mine: {} } })}\n`);
			return await fetch(input, init);
		};
		const result = await applyClineLocalAiProvider({ ...options(), fetch: editingFetch });
		expect(result.status).toBe("error");
		expect(result.lines.at(-1)).toContain("changed while LocalAI was asked");
		expect(Object.keys(read().providers)).toEqual(["mine"]);
	});

	it("leaves a providers.json that isn't JSON alone, and writes neither file", async () => {
		mkdirSync(join(root.path, "cline", "data", "settings"), { recursive: true });
		writeFileSync(providersPath, "{ not json");
		const result = await applyClineLocalAiProvider(options());
		expect(result).toMatchObject({
			status: "error",
			lines: [expect.stringContaining("providers.json: not valid JSON")],
		});
		expect(() => statSync(modelsPath)).toThrow();
	});

	it("leaves a models.json that isn't JSON alone", async () => {
		mkdirSync(join(root.path, "cline", "data", "settings"), { recursive: true });
		writeFileSync(modelsPath, "{ not json");
		const result = await applyClineLocalAiProvider(options());
		expect(result.status).toBe("error");
		expect(readFileSync(modelsPath, "utf8")).toBe("{ not json");
	});
});
