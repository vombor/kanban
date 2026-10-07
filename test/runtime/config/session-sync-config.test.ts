import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadGlobalRuntimeConfig, updateGlobalRuntimeConfig } from "../../../src/config/runtime-config";
import { parseSessionSyncSetting, readSessionSyncSetting } from "../../../src/config/session-sync-config";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

describe("parseSessionSyncSetting", () => {
	it("is on by default in this fork", () => {
		expect(parseSessionSyncSetting({})).toEqual({ enabled: true, warning: null });
		expect(parseSessionSyncSetting(null)).toEqual({ enabled: true, warning: null });
	});

	it("reads true and false", () => {
		expect(parseSessionSyncSetting({ sessionSync: false })).toEqual({ enabled: false, warning: null });
		expect(parseSessionSyncSetting({ sessionSync: true })).toEqual({ enabled: true, warning: null });
	});

	it("warns and uses the default for a value that isn't a boolean", () => {
		const parsed = parseSessionSyncSetting({ sessionSync: "off" });
		expect(parsed.enabled).toBe(true);
		expect(parsed.warning).toContain('"off"');
	});
});

describe.sequential("readSessionSyncSetting", () => {
	it("uses the default without a warning when config.json does not exist", async () => {
		await withTemporaryKanbanHome(async () => {
			expect(await readSessionSyncSetting()).toEqual({ enabled: true, warning: null });
		});
	});

	it("reads `sessionSync: false` from the Kanban home's config.json", async () => {
		await withTemporaryKanbanHome(async (home) => {
			mkdirSync(home.homePath, { recursive: true });
			writeFileSync(
				home.globalConfigPath,
				JSON.stringify({ selectedAgentId: "claude", sessionSync: false }),
				"utf8",
			);
			expect(await readSessionSyncSetting()).toEqual({ enabled: false, warning: null });
		});
	});

	it("warns and uses the default for a config.json that doesn't parse", async () => {
		await withTemporaryKanbanHome(async (home) => {
			mkdirSync(home.homePath, { recursive: true });
			writeFileSync(home.globalConfigPath, "{ not json", "utf8");
			const setting = await readSessionSyncSetting();
			expect(setting.enabled).toBe(true);
			expect(setting.warning).toContain("Could not parse");
		});
	});

	it("survives a settings save (the settings dialog never writes it)", async () => {
		await withTemporaryKanbanHome(async (home) => {
			mkdirSync(home.homePath, { recursive: true });
			writeFileSync(home.globalConfigPath, JSON.stringify({ sessionSync: false }), "utf8");
			await updateGlobalRuntimeConfig(await loadGlobalRuntimeConfig(), { selectedAgentId: "codex" });
			expect(JSON.parse(readFileSync(home.globalConfigPath, "utf8")).sessionSync).toBe(false);
			expect((await readSessionSyncSetting()).enabled).toBe(false);
		});
	});
});
