import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setModelListInclude, unsetModelListInclude } from "../../../src/config/model-list-include-setting";
import { parseLemonadeModelListSettings } from "../../../src/config/model-lists-config";
import { createTempDir } from "../../utilities/temp-dir";

describe("kanban config set|unset models.lists.lemonade.include", () => {
	let dir: { path: string; cleanup: () => void };
	let configPath: string;

	beforeEach(() => {
		dir = createTempDir("kanban-config-include-");
		configPath = join(dir.path, "config.json");
		writeFileSync(
			configPath,
			`${JSON.stringify({ models: { lists: { lemonade: { url: "http://10.0.0.5:13305" } } }, other: { keep: true } })}\n`,
		);
	});

	afterEach(() => {
		dir.cleanup();
	});

	function read(): Record<string, unknown> {
		return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	}

	it("sets the include, keeping every other key, and unsets it again", async () => {
		const set = await setModelListInclude(
			"models.lists.lemonade.include",
			["Muse-Glimmer-30B-GGUF-Q4_K_M", "gemma-4-31B-it-qat-q4_0-gguf-Q4_0", "Muse-Glimmer-30B-GGUF-Q4_K_M"],
			configPath,
		);
		expect(set).toMatchObject({
			from: undefined,
			to: ["Muse-Glimmer-30B-GGUF-Q4_K_M", "gemma-4-31B-it-qat-q4_0-gguf-Q4_0"],
			next: expect.stringContaining("models record in Cline's models.json"),
		});
		const written = read();
		expect(written.other).toEqual({ keep: true });
		expect(parseLemonadeModelListSettings(written).settings).toEqual({
			url: "http://10.0.0.5:13305",
			requireLabels: ["tool-calling"],
			include: ["Muse-Glimmer-30B-GGUF-Q4_K_M", "gemma-4-31B-it-qat-q4_0-gguf-Q4_0"],
		});

		const unset = await unsetModelListInclude("models.lists.lemonade.include", configPath);
		expect(unset.from).toEqual(["Muse-Glimmer-30B-GGUF-Q4_K_M", "gemma-4-31B-it-qat-q4_0-gguf-Q4_0"]);
		expect(read().models).toEqual({ lists: { lemonade: { url: "http://10.0.0.5:13305" } } });
	});

	it("refuses any other key and an empty list, writing nothing", async () => {
		const before = readFileSync(configPath, "utf8");
		await expect(setModelListInclude("models.lists.lemonade.url", ["http://x"], configPath)).rejects.toThrow(
			/only models.lists.lemonade.include can be set/u,
		);
		await expect(setModelListInclude("models.lists.lemonade.include", [" "], configPath)).rejects.toThrow(
			/at least one model id/u,
		);
		await expect(unsetModelListInclude("isolation.mode", configPath)).rejects.toThrow(/only/u);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});
});
