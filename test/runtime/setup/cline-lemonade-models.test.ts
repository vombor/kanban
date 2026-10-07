import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkClineLemonadeContextWindows } from "../../../src/doctor/cline-models-checks";
import { maxTokensForContextWindow, planClineLemonadeModels } from "../../../src/setup/cline-lemonade-models";
import { createFakeLemonadeFetch, LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const LABELS = ["tool-calling"];

// The pod's ~/.cline/data/settings/models.json on 2026-10-07 (models as a list), with Lemonade at a test origin.
function clineModelsFile(models: unknown): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: {
					name: "Lemonade (local)",
					baseUrl: "http://lemonade.test:13305/api/v1",
					modelsSourceUrl: "http://127.0.0.1:3485/api/model-lists/lemonade",
					defaultModelId: "GLM-4.7-Flash-GGUF",
					protocol: "openai-chat",
					capabilities: ["tools"],
				},
				models,
			},
			other: { provider: { name: "Other", baseUrl: "http://other.test/v1" }, models: ["x"] },
		},
	};
}

type ModelsDocument = {
	providers: {
		lemonade: { provider: Record<string, unknown>; models: Record<string, Record<string, unknown>> };
		other: unknown;
	};
};

describe("Cline models.json Lemonade metadata step", () => {
	let dir: { path: string; cleanup: () => void };
	let modelsPath: string;

	beforeEach(() => {
		dir = createTempDir("kanban-cline-lemonade-");
		modelsPath = join(dir.path, "models.json");
	});

	afterEach(() => {
		dir.cleanup();
	});

	function write(document: unknown): void {
		writeFileSync(modelsPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o640 });
	}

	function read(): ModelsDocument {
		return JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsDocument;
	}

	function backups(): string[] {
		return readdirSync(dir.path).filter((name) => name.includes(".bak-before-kanban-setup-"));
	}

	function plan(fetchImpl: typeof fetch = createFakeLemonadeFetch()) {
		return planClineLemonadeModels({ modelsPath, requireLabels: LABELS, fetch: fetchImpl, now: NOW });
	}

	it("sizes maxTokens at a quarter of the window, at most 32K", () => {
		expect(maxTokensForContextWindow(202752)).toBe(32768);
		expect(maxTokensForContextWindow(65536)).toBe(16384);
		expect(maxTokensForContextWindow(4096)).toBe(1024);
	});

	it("turns the list into a record with each listed model's real window, vision and reasoning", async () => {
		write(clineModelsFile(["Qwen3-Coder-Next-GGUF", "GLM-4.7-Flash-GGUF", "Gemma-4-12B-it-GGUF"]));
		const before = readFileSync(modelsPath, "utf8");
		const fetchImpl = createFakeLemonadeFetch();

		const result = await plan(fetchImpl);
		expect(result.action).toBe("update");
		expect(result.details).toContain("GLM-4.7-Flash-GGUF: context 202752 (recipe ctx_size), maxTokens 32768");
		expect(result.details).toContain(
			"Qwen3.6-35B-A3B-MTP-GGUF (added): context 262144 (model max; Lemonade auto-tunes up to it), maxTokens 32768, vision",
		);
		expect(result.details).toContain(
			"Mystery-Coder-GGUF (added): no context info from Lemonade; Cline's 128000 default",
		);
		// Metadata comes from the server Cline talks to (the provider's baseUrl).
		expect(fetchImpl.urls).toContain("http://lemonade.test:13305/api/v1/models");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);

		const lines = await result.apply?.();
		expect(lines?.[0]).toBe("lemonade models: wrote metadata for 6 model(s)");
		const after = read();
		expect(after.providers.lemonade.models).toEqual({
			// Not in Lemonade any more: kept, only in record form.
			"Qwen3-Coder-Next-GGUF": { id: "Qwen3-Coder-Next-GGUF", name: "Qwen3-Coder-Next-GGUF" },
			"GLM-4.7-Flash-GGUF": {
				id: "GLM-4.7-Flash-GGUF",
				name: "GLM-4.7-Flash-GGUF",
				contextWindow: 202752,
				maxTokens: 32768,
				supportsVision: false,
				supportsReasoning: false,
				inputPrice: 0,
				outputPrice: 0,
			},
			"Gemma-4-12B-it-GGUF": {
				id: "Gemma-4-12B-it-GGUF",
				name: "Gemma-4-12B-it-GGUF",
				contextWindow: 65536,
				maxTokens: 16384,
				supportsVision: true,
				supportsReasoning: false,
				inputPrice: 0,
				outputPrice: 0,
			},
			"Devstral-Small-2507-GGUF": expect.objectContaining({ contextWindow: 131072, maxTokens: 32768 }),
			"Qwen3.6-35B-A3B-MTP-GGUF": expect.objectContaining({ contextWindow: 262144, supportsVision: true }),
			"gpt-oss-20b-mxfp4-GGUF": expect.objectContaining({ contextWindow: 131072, supportsReasoning: true }),
			"Mystery-Coder-GGUF": {
				id: "Mystery-Coder-GGUF",
				name: "Mystery-Coder-GGUF",
				supportsVision: false,
				supportsReasoning: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		});
		// Image and speech models, and models not downloaded, never reach Cline.
		expect(Object.keys(after.providers.lemonade.models)).not.toContain("Flux-2-Klein-9B-GGUF");
		expect(Object.keys(after.providers.lemonade.models)).not.toContain("Not-Downloaded-GGUF");
		// Only the lemonade models change.
		const expected = clineModelsFile([]) as ModelsDocument;
		expect(after.providers.lemonade.provider).toEqual(expected.providers.lemonade.provider);
		expect(after.providers.other).toEqual(expected.providers.other);
		expect(statSync(modelsPath).mode & 0o777).toBe(0o640);
		expect(backups()).toEqual(["models.json.bak-before-kanban-setup-20261007T120000Z"]);
		expect(readFileSync(join(dir.path, backups()[0] ?? ""), "utf8")).toBe(before);
	});

	it("is idempotent: a second run is up to date and writes nothing", async () => {
		write(clineModelsFile(["GLM-4.7-Flash-GGUF"]));
		await (await plan()).apply?.();
		const once = readFileSync(modelsPath, "utf8");

		const again = await plan();
		expect(again.action).toBe("up-to-date");
		expect(again.apply).toBeUndefined();
		expect(readFileSync(modelsPath, "utf8")).toBe(once);
		expect(backups()).toHaveLength(1);
	});

	it("keeps the user's names and other keys, and follows Lemonade when a window changes", async () => {
		write(
			clineModelsFile({
				"GLM-4.7-Flash-GGUF": {
					id: "GLM-4.7-Flash-GGUF",
					name: "GLM Flash",
					contextWindow: 128000,
					temperature: 0.6,
					inputPrice: 1,
				},
			}),
		);
		await (await plan(createFakeLemonadeFetch({ health: LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD }))).apply?.();
		const models = read().providers.lemonade.models;
		expect(models["GLM-4.7-Flash-GGUF"]).toEqual({
			id: "GLM-4.7-Flash-GGUF",
			name: "GLM Flash",
			contextWindow: 202752,
			temperature: 0.6,
			inputPrice: 1,
			maxTokens: 32768,
			supportsVision: false,
			supportsReasoning: false,
			outputPrice: 0,
		});
		// Loaded below its max: the loaded size is what llama-server runs with.
		expect(models["Qwen3.6-35B-A3B-MTP-GGUF"]?.contextWindow).toBe(98304);
	});

	it("never claims more than a positive global ctx_size for a model without its own", async () => {
		write(clineModelsFile({}));
		await (await plan(createFakeLemonadeFetch({ params: { ctx_size: 32768 } }))).apply?.();
		const models = read().providers.lemonade.models;
		expect(models["Qwen3.6-35B-A3B-MTP-GGUF"]?.contextWindow).toBe(32768);
		expect(models["Mystery-Coder-GGUF"]?.contextWindow).toBe(32768);
		expect(models["GLM-4.7-Flash-GGUF"]?.contextWindow).toBe(202752);
	});

	it("with Lemonade down keeps every value, says so, and writes only to fix a list", async () => {
		const record = {
			"GLM-4.7-Flash-GGUF": { id: "GLM-4.7-Flash-GGUF", name: "GLM-4.7-Flash-GGUF", contextWindow: 202752 },
		};
		write(clineModelsFile(record));
		const before = readFileSync(modelsPath, "utf8");
		const down = await plan(createFakeLemonadeFetch({ down: true }));
		expect(down.action).toBe("unreachable");
		expect(down.details[0]).toBe(
			"Lemonade at http://lemonade.test:13305/api/v1 did not answer (fetch failed); existing model values kept",
		);
		expect(readFileSync(modelsPath, "utf8")).toBe(before);

		write(clineModelsFile(["GLM-4.7-Flash-GGUF"]));
		const list = await plan(createFakeLemonadeFetch({ down: true }));
		expect(list.action).toBe("update");
		await list.apply?.();
		expect(read().providers.lemonade.models).toEqual({
			"GLM-4.7-Flash-GGUF": { id: "GLM-4.7-Flash-GGUF", name: "GLM-4.7-Flash-GGUF" },
		});
	});

	it("skips a machine without models.json or a Lemonade provider, and leaves a broken file alone", async () => {
		const fetchImpl = createFakeLemonadeFetch();
		expect((await plan(fetchImpl)).action).toBe("skip");
		write({ version: 1, providers: { other: { models: {} } } });
		expect((await plan(fetchImpl)).action).toBe("skip");
		writeFileSync(modelsPath, "{ not json");
		expect((await plan(fetchImpl)).action).toBe("error");
		expect(fetchImpl.urls).toEqual([]);
	});

	describe("doctor row", () => {
		it("warns about a list (Cline drops the provider) and models on the 128K default, passes real windows", async () => {
			expect(await checkClineLemonadeContextWindows(modelsPath)).toEqual([]);

			write(clineModelsFile(["GLM-4.7-Flash-GGUF"]));
			const [list] = await checkClineLemonadeContextWindows(modelsPath);
			expect(list?.level).toBe("warn");
			expect(list?.message).toContain("is a list, which cline 3.x rejects");
			expect(list?.hint).toBe("kanban setup");

			write(
				clineModelsFile({
					"GLM-4.7-Flash-GGUF": { contextWindow: 202752 },
					"Mystery-Coder-GGUF": { name: "Mystery-Coder-GGUF" },
				}),
			);
			const [partial] = await checkClineLemonadeContextWindows(modelsPath);
			expect(partial?.level).toBe("warn");
			expect(partial?.message).toBe(
				`cline lemonade models (${modelsPath}): 1 of 2 on Cline's 128000 default (Mystery-Coder-GGUF); real: GLM-4.7-Flash-GGUF 202752`,
			);

			write(clineModelsFile({ "GLM-4.7-Flash-GGUF": { contextWindow: 202752 } }));
			const [pass] = await checkClineLemonadeContextWindows(modelsPath);
			expect(pass).toEqual({
				level: "pass",
				area: "setup",
				message: `cline lemonade models (${modelsPath}): real context windows: GLM-4.7-Flash-GGUF 202752`,
			});
		});
	});
});
