import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type LemonadeContextSyncMode,
	syncClineLemonadeContextWindows,
} from "../../../src/setup/cline-lemonade-context-sync";
import {
	createFakeLemonadeFetch,
	LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD,
	LEMONADE_MODELS_PAYLOAD,
} from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

const NOW = new Date("2026-10-11T06:00:00.000Z");
const SOURCE_URL = "http://127.0.0.1:3485/api/model-lists/lemonade";

type Models = Record<string, Record<string, unknown>>;

function entry(id: string, fields: Record<string, unknown>): Record<string, unknown> {
	return { id, name: id, supportsVision: false, supportsReasoning: false, inputPrice: 0, outputPrice: 0, ...fields };
}

function clineModelsFile(models: unknown): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: {
					name: "Lemonade (local)",
					baseUrl: "http://lemonade.test:13305/api/v1",
					modelsSourceUrl: SOURCE_URL,
					apiKey: "secret-in-the-file",
				},
				models,
			},
			other: { provider: { name: "Other" }, models: ["x"] },
		},
	};
}

// GLM was reloaded at its recipe's 202752 while Cline still has 65536; Gemma's window is right but Cline lacks its
// vision flag (the user's); gpt-oss would only get the model's max; Old is gone from Lemonade (the user's).
function reloadedFile(): Record<string, unknown> {
	return clineModelsFile({
		"GLM-4.7-Flash-GGUF": entry("GLM-4.7-Flash-GGUF", { contextWindow: 65536, maxTokens: 16384, custom: "keep" }),
		"Gemma-4-12B-it-GGUF": entry("Gemma-4-12B-it-GGUF", { contextWindow: 65536, maxTokens: 16384 }),
		"gpt-oss-20b-mxfp4-GGUF": entry("gpt-oss-20b-mxfp4-GGUF", {
			contextWindow: 65536,
			maxTokens: 16384,
			supportsReasoning: true,
		}),
		"Old-GGUF": { id: "Old-GGUF", name: "Old-GGUF", contextWindow: 4096 },
	});
}

describe("Cline Lemonade context sync", () => {
	let dir: { path: string; cleanup: () => void };
	let modelsPath: string;
	let backupDir: string;

	beforeEach(() => {
		// Never the real ~/.cline: a temp models.json and a temp backup dir.
		dir = createTempDir("kanban-cline-context-sync-");
		modelsPath = join(dir.path, "models.json");
		backupDir = join(dir.path, "kanban-home", "backups", "cline");
	});

	afterEach(() => {
		dir.cleanup();
	});

	function write(document: unknown): string {
		const raw = `${JSON.stringify(document, null, 2)}\n`;
		writeFileSync(modelsPath, raw, { mode: 0o640 });
		return raw;
	}

	function readModels(): Models {
		const document = JSON.parse(readFileSync(modelsPath, "utf8")) as {
			providers: { lemonade: { models: Models } };
		};
		return document.providers.lemonade.models;
	}

	function sync(options: { mode?: LemonadeContextSyncMode; fetch?: typeof fetch } = {}) {
		return syncClineLemonadeContextWindows({
			modelsPath,
			mode: options.mode ?? "on",
			requireLabels: ["tool-calling"],
			backupDir,
			fetch: options.fetch ?? createFakeLemonadeFetch(),
			now: NOW,
		});
	}

	it("writes only contextWindow and maxTokens of listed models from their recipe ctx_size, after a backup", async () => {
		const before = write(reloadedFile());
		const document = JSON.parse(before) as Record<string, unknown>;

		const result = await sync();

		expect(result.status).toBe("written");
		expect(result.lemonadeApiBaseUrl).toBe("http://lemonade.test:13305/api/v1");
		expect(result.changes).toEqual([
			{
				id: "GLM-4.7-Flash-GGUF",
				contextWindow: { from: 65536, to: 202752 },
				maxTokens: { from: 16384, to: 32768 },
				lemonade: { ctxSize: 202752, source: "recipe" },
			},
		]);
		// gpt-oss has no recipe ctx_size: its window would be max_context_window, which is not what it loads with.
		expect(result.skipped).toEqual([
			{
				id: "gpt-oss-20b-mxfp4-GGUF",
				reason: "its window would come from the model's max_context_window, not its recipe_options.ctx_size",
			},
		]);
		// Models to add (Devstral, Qwen, Mystery), Old to remove and Gemma's vision flag are the user's.
		expect(result.userDifferences).toBeGreaterThanOrEqual(5);

		const models = readModels();
		expect(models["GLM-4.7-Flash-GGUF"]).toEqual(
			entry("GLM-4.7-Flash-GGUF", { contextWindow: 202752, maxTokens: 32768, custom: "keep" }),
		);
		const original = (document.providers as { lemonade: { models: Models } }).lemonade.models;
		expect(models["Gemma-4-12B-it-GGUF"]).toEqual(original["Gemma-4-12B-it-GGUF"]);
		expect(models["gpt-oss-20b-mxfp4-GGUF"]).toEqual(original["gpt-oss-20b-mxfp4-GGUF"]);
		expect(models["Old-GGUF"]).toEqual(original["Old-GGUF"]);
		expect(Object.keys(models).sort()).toEqual(Object.keys(original).sort());
		// The rest of the file is as it was.
		const after = JSON.parse(readFileSync(modelsPath, "utf8")) as typeof document;
		expect({ ...after, providers: { ...(after.providers as object), lemonade: null } }).toEqual({
			...document,
			providers: { ...(document.providers as object), lemonade: null },
		});
		expect((after.providers as { lemonade: { provider: unknown } }).lemonade.provider).toEqual(
			(document.providers as { lemonade: { provider: unknown } }).lemonade.provider,
		);
		expect(statSync(modelsPath).mode & 0o777).toBe(0o640);
		expect(result.backupPath).toBe(join(backupDir, "models.json.20261011T060000Z"));
		expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(before);
		expect(readdirSync(dir.path).sort()).toEqual(["kanban-home", "models.json"]);

		// Nothing left to sync; the user's differences stay.
		const again = await sync();
		expect(again.status).toBe("skipped");
		expect(again.changes).toEqual([]);
	});

	it("takes a loaded model's ctx_size (a reload) and lowers the window too", async () => {
		write(
			clineModelsFile({
				"Qwen3.6-35B-A3B-MTP-GGUF": entry("Qwen3.6-35B-A3B-MTP-GGUF", {
					contextWindow: 131072,
					maxTokens: 32768,
					supportsVision: true,
				}),
			}),
		);
		// Not loaded: Lemonade only knows its max, so nothing is written.
		expect((await sync()).status).toBe("skipped");

		const result = await sync({ fetch: createFakeLemonadeFetch({ health: LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD }) });
		expect(result.status).toBe("written");
		expect(result.changes).toEqual([
			{
				id: "Qwen3.6-35B-A3B-MTP-GGUF",
				contextWindow: { from: 131072, to: 98304 },
				maxTokens: { from: 32768, to: 24576 },
				lemonade: { ctxSize: 98304, source: "loaded" },
			},
		]);
		expect(readModels()["Qwen3.6-35B-A3B-MTP-GGUF"]).toMatchObject({ contextWindow: 98304, maxTokens: 24576 });
	});

	it("sets a window Cline never had, and fixes a maxTokens that doesn't follow the window", async () => {
		write(
			clineModelsFile({
				"GLM-4.7-Flash-GGUF": entry("GLM-4.7-Flash-GGUF", {}),
				"Devstral-Small-2507-GGUF": entry("Devstral-Small-2507-GGUF", { contextWindow: 131072, maxTokens: 999 }),
			}),
		);
		const result = await sync();
		expect(result.changes).toEqual([
			expect.objectContaining({
				id: "Devstral-Small-2507-GGUF",
				contextWindow: { from: 131072, to: 131072 },
				maxTokens: { from: 999, to: 32768 },
			}),
			expect.objectContaining({
				id: "GLM-4.7-Flash-GGUF",
				contextWindow: { from: undefined, to: 202752 },
				maxTokens: { from: undefined, to: 32768 },
			}),
		]);
	});

	it("only reports in report mode", async () => {
		const before = write(reloadedFile());
		const result = await sync({ mode: "report" });
		expect(result.status).toBe("would-write");
		expect(result.changes.map((change) => change.id)).toEqual(["GLM-4.7-Flash-GGUF"]);
		expect(result.backupPath).toBeNull();
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		expect(readdirSync(dir.path)).toEqual(["models.json"]);
	});

	it("leaves the list form, a Lemonade that is down and a missing or broken file alone", async () => {
		const list = write(clineModelsFile(["GLM-4.7-Flash-GGUF"]));
		const listResult = await sync();
		expect(listResult.status).toBe("skipped");
		expect(listResult.skipped).toEqual([
			{ id: null, reason: "models is a list, which only setup-provider lemonade rewrites" },
		]);
		expect(readFileSync(modelsPath, "utf8")).toBe(list);

		const before = write(reloadedFile());
		const down = await sync({ fetch: createFakeLemonadeFetch({ down: true }) });
		expect(down.status).toBe("unreachable");
		expect(down.detail).toContain("did not answer");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);

		writeFileSync(modelsPath, "{ not json");
		expect((await sync()).status).toBe("unreadable");
		expect(readFileSync(modelsPath, "utf8")).toBe("{ not json");

		write({ version: 1, providers: { other: { models: {} } } });
		expect((await sync()).status).toBe("absent");
		expect(readdirSync(dir.path)).toEqual(["models.json"]);
	});

	it("writes nothing when models.json changes while Lemonade is asked", async () => {
		write(reloadedFile());
		const fakeLemonade = createFakeLemonadeFetch({ models: LEMONADE_MODELS_PAYLOAD });
		const edited = `${JSON.stringify(clineModelsFile({}), null, 2)}\n`;
		const editingFetch = (async (input: string | URL | Request) => {
			writeFileSync(modelsPath, edited);
			return await fakeLemonade(input);
		}) as typeof fetch;

		const result = await sync({ fetch: editingFetch });
		expect(result.status).toBe("failed");
		expect(result.detail).toContain("changed while Lemonade was asked");
		expect(readFileSync(modelsPath, "utf8")).toBe(edited);
		expect(readdirSync(dir.path)).toEqual(["models.json"]);
	});
});
