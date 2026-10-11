import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	ClineLemonadeContextSyncMode,
	ClineLemonadeContextSyncSettings,
} from "../../../src/config/cline-lemonade-context-sync-config";
import {
	type ClineLemonadeContextSyncRecord,
	createClineLemonadeContextSyncMonitor,
} from "../../../src/server/cline-lemonade-context-sync-monitor";
import { getClineModelsSettingsPath } from "../../../src/state/kanban-home";
import { createFakeLemonadeFetch } from "../../utilities/lemonade-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

function clineModelsFile(glmWindow: number): Record<string, unknown> {
	return {
		version: 1,
		providers: {
			lemonade: {
				provider: { name: "Lemonade (local)", baseUrl: "http://lemonade.test:13305/api/v1" },
				models: {
					"GLM-4.7-Flash-GGUF": {
						id: "GLM-4.7-Flash-GGUF",
						name: "GLM-4.7-Flash-GGUF",
						contextWindow: glmWindow,
						maxTokens: 16384,
						supportsVision: false,
						supportsReasoning: false,
						inputPrice: 0,
						outputPrice: 0,
					},
				},
			},
		},
	};
}

describe("Cline Lemonade context sync monitor", () => {
	let dir: { path: string; cleanup: () => void };
	let dataDir: string;
	let modelsPath: string;
	let historyPath: string;
	let mode: ClineLemonadeContextSyncMode;
	let fetchImpl: typeof fetch;
	let logs: string[];

	beforeEach(() => {
		// A temp Cline data dir and Kanban home; the fake Lemonade answers at any origin.
		dir = createTempDir("kanban-cline-context-sync-monitor-");
		dataDir = join(dir.path, "cline-data");
		modelsPath = getClineModelsSettingsPath(dataDir);
		historyPath = join(dir.path, "kanban-home", "data", "models", "cline-lemonade-sync.jsonl");
		mkdirSync(join(dataDir, "settings"), { recursive: true });
		mode = "on";
		fetchImpl = createFakeLemonadeFetch();
		logs = [];
	});

	afterEach(() => {
		dir.cleanup();
	});

	function createMonitor() {
		return createClineLemonadeContextSyncMonitor({
			loadSettings: async (): Promise<ClineLemonadeContextSyncSettings> => ({ mode, intervalSec: 30, dataDir }),
			loadLemonadeModelList: async () => ({ url: "http://lemonade.test:13305", requireLabels: ["tool-calling"] }),
			log: (message) => logs.push(message),
			historyPath,
			backupDir: join(dir.path, "kanban-home", "backups", "cline"),
			fetch: (async (input: string | URL | Request) => await fetchImpl(input)) as typeof fetch,
			now: () => new Date("2026-10-11T06:25:00.000Z"),
		});
	}

	function history(): ClineLemonadeContextSyncRecord[] {
		if (!existsSync(historyPath)) {
			return [];
		}
		return readFileSync(historyPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as ClineLemonadeContextSyncRecord);
	}

	function glmWindow(): unknown {
		const document = JSON.parse(readFileSync(modelsPath, "utf8")) as {
			providers: { lemonade: { models: Record<string, { contextWindow?: unknown }> } };
		};
		return document.providers.lemonade.models["GLM-4.7-Flash-GGUF"]?.contextWindow;
	}

	it("writes a reloaded model's window and logs old -> new with the Lemonade value, in the log and the history", async () => {
		writeFileSync(modelsPath, JSON.stringify(clineModelsFile(65536)));
		const monitor = createMonitor();

		const result = await monitor.sync("launch");

		expect(result?.status).toBe("written");
		expect(glmWindow()).toBe(202752);
		expect(logs[0]).toContain(`[cline-lemonade-sync] wrote ${modelsPath} (backup `);
		expect(logs).toContain(
			"[cline-lemonade-sync]   GLM-4.7-Flash-GGUF: contextWindow 65536 -> 202752, maxTokens 16384 -> 32768 (Lemonade recipe's recipe_options.ctx_size 202752)",
		);
		expect(history()).toEqual([
			{
				at: "2026-10-11T06:25:00.000Z",
				trigger: "launch",
				status: "written",
				modelsPath,
				lemonadeApiBaseUrl: "http://lemonade.test:13305/api/v1",
				changes: [
					{
						id: "GLM-4.7-Flash-GGUF",
						contextWindow: { from: 65536, to: 202752 },
						maxTokens: { from: 16384, to: 32768 },
						lemonade: { ctxSize: 202752, source: "recipe" },
					},
				],
				skipped: [],
				backupPath: result?.backupPath,
				detail: null,
			},
		]);

		// In sync now: nothing more is logged or written.
		logs.length = 0;
		expect((await monitor.sync("sweep"))?.status).toBe("in-sync");
		expect(logs).toEqual([]);
		expect(history()).toHaveLength(1);
		monitor.close();
	});

	it("only reports in report mode, once per distinct outcome, and does nothing when off", async () => {
		writeFileSync(modelsPath, JSON.stringify(clineModelsFile(65536)));
		const before = readFileSync(modelsPath, "utf8");
		mode = "report";
		const monitor = createMonitor();

		expect((await monitor.sync("sweep"))?.status).toBe("would-write");
		expect((await monitor.sync("sweep"))?.status).toBe("would-write");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		expect(logs[0]).toBe(
			`[cline-lemonade-sync] would write ${modelsPath} (agents.cline.lemonadeContextSync.mode is report)`,
		);
		expect(history().map((record) => record.status)).toEqual(["would-write"]);

		mode = "off";
		logs.length = 0;
		expect(await monitor.sync("launch")).toBeNull();
		expect(logs).toEqual([]);
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		monitor.close();
	});

	it("logs a failed write and a skipped change, and Lemonade being down only in the server log", async () => {
		// models.json changes while Lemonade is asked: a failed write.
		writeFileSync(modelsPath, JSON.stringify(clineModelsFile(65536)));
		const lemonade = createFakeLemonadeFetch();
		fetchImpl = (async (input: string | URL | Request) => {
			writeFileSync(modelsPath, JSON.stringify(clineModelsFile(1234)));
			return await lemonade(input);
		}) as typeof fetch;
		const monitor = createMonitor();
		expect((await monitor.sync("sweep"))?.status).toBe("failed");
		expect(logs[0]).toContain(`could not write ${modelsPath}: models.json changed while Lemonade was asked`);
		expect(history().map((record) => record.status)).toEqual(["failed"]);

		// A window that would only come from the model's max is skipped.
		fetchImpl = createFakeLemonadeFetch({
			models: {
				data: [{ id: "GLM-4.7-Flash-GGUF", labels: ["tool-calling"], max_context_window: 202752 }],
			},
		});
		expect((await monitor.sync("sweep"))?.status).toBe("skipped");
		expect(history().at(-1)).toMatchObject({
			status: "skipped",
			skipped: [{ id: "GLM-4.7-Flash-GGUF", reason: expect.stringContaining("max_context_window") }],
		});
		expect(glmWindow()).toBe(1234);

		logs.length = 0;
		fetchImpl = createFakeLemonadeFetch({ down: true });
		expect((await monitor.sync("sweep"))?.status).toBe("unreachable");
		expect((await monitor.sync("sweep"))?.status).toBe("unreachable");
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("did not answer");
		expect(history()).toHaveLength(2);
		monitor.close();
	});
});
