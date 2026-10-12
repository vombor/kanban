import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	createLemonadeModelListSettingsLoader,
	DEFAULT_LEMONADE_MODEL_LIST_SETTINGS,
	parseLemonadeModelListSettings,
	readLemonadeModelListSettings,
} from "../../../src/config/model-lists-config";
import { createTempDir } from "../../utilities/temp-dir";

describe("lemonade model list settings", () => {
	it("defaults to the local Lemonade server and tool-calling models", () => {
		expect(parseLemonadeModelListSettings({})).toEqual({
			settings: { url: "http://localhost:13305", requireLabels: ["tool-calling"], include: null },
			warning: null,
		});
		expect(parseLemonadeModelListSettings(null).settings).toEqual(DEFAULT_LEMONADE_MODEL_LIST_SETTINGS);
	});

	it("reads models.lists.lemonade", () => {
		expect(
			parseLemonadeModelListSettings({
				models: { lists: { lemonade: { url: "http://10.0.0.5:8000", requireLabels: ["tool-calling", "coding"] } } },
			}),
		).toEqual({
			settings: { url: "http://10.0.0.5:8000", requireLabels: ["tool-calling", "coding"], include: null },
			warning: null,
		});
		// An empty list means every downloaded model.
		expect(
			parseLemonadeModelListSettings({ models: { lists: { lemonade: { requireLabels: [] } } } }).settings
				.requireLabels,
		).toEqual([]);
	});

	it("reads models.lists.lemonade.include, and refuses an empty or non-list one with a warning", () => {
		const read = (include: unknown) =>
			parseLemonadeModelListSettings({ models: { lists: { lemonade: { include } } } });
		expect(read(["Muse-Glimmer-30B-GGUF-Q4_K_M", " gemma-4-31B ", "Muse-Glimmer-30B-GGUF-Q4_K_M"])).toEqual({
			settings: {
				...DEFAULT_LEMONADE_MODEL_LIST_SETTINGS,
				include: ["Muse-Glimmer-30B-GGUF-Q4_K_M", "gemma-4-31B"],
			},
			warning: null,
		});
		expect(read(null)).toEqual({ settings: DEFAULT_LEMONADE_MODEL_LIST_SETTINGS, warning: null });
		for (const bad of [[], "Muse", [""], [1]]) {
			const parsed = read(bad);
			expect(parsed.settings.include).toBeNull();
			expect(parsed.warning).toContain("models.lists.lemonade.include");
		}
	});

	it("ignores values of the wrong type with a warning", () => {
		const parsed = parseLemonadeModelListSettings({
			models: { lists: { lemonade: { url: "ftp://lemonade", requireLabels: "tool-calling" } } },
		});

		expect(parsed.settings).toEqual(DEFAULT_LEMONADE_MODEL_LIST_SETTINGS);
		expect(parsed.warning).toContain('"ftp://lemonade"');
		expect(parsed.warning).toContain("requireLabels");
	});

	it("uses the defaults for a missing or broken config.json", async () => {
		const { path, cleanup } = createTempDir("kanban-model-lists-config-");
		try {
			expect(await readLemonadeModelListSettings(join(path, "missing.json"))).toEqual({
				settings: DEFAULT_LEMONADE_MODEL_LIST_SETTINGS,
				warning: null,
			});
			const configPath = join(path, "config.json");
			writeFileSync(configPath, "{ not json");
			const broken = await readLemonadeModelListSettings(configPath);
			expect(broken.settings).toEqual(DEFAULT_LEMONADE_MODEL_LIST_SETTINGS);
			expect(broken.warning).toContain("Could not parse");
		} finally {
			cleanup();
		}
	});

	it("re-reads config.json on every load and logs each distinct warning once", async () => {
		const { path, cleanup } = createTempDir("kanban-model-lists-config-");
		try {
			const configPath = join(path, "config.json");
			const warn = vi.fn();
			const load = createLemonadeModelListSettingsLoader(warn, configPath);
			writeFileSync(configPath, JSON.stringify({ models: { lists: { lemonade: { url: 42 } } } }));
			await load();
			await load();
			expect(warn).toHaveBeenCalledTimes(1);
			writeFileSync(configPath, JSON.stringify({ models: { lists: { lemonade: { url: "http://127.0.0.1:9" } } } }));
			expect((await load()).url).toBe("http://127.0.0.1:9");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			cleanup();
		}
	});
});
