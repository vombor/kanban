import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	createProcessReaperSettingsLoader,
	DEFAULT_PROCESS_REAPER_SETTINGS,
	parseProcessReaperSettings,
	readProcessReaperSettings,
} from "../../../src/config/process-reaper-config";
import { createTempDir } from "../../utilities/temp-dir";

describe("process reaper settings", () => {
	it("defaults to terminating orphans every five minutes", () => {
		expect(parseProcessReaperSettings({})).toEqual({
			settings: { enabled: true, intervalSec: 300, mode: "terminate" },
			warning: null,
		});
		expect(parseProcessReaperSettings(null).settings).toEqual(DEFAULT_PROCESS_REAPER_SETTINGS);
	});

	it("reads processes.reaper and clamps the interval", () => {
		expect(
			parseProcessReaperSettings({ processes: { reaper: { enabled: false, intervalSec: 900, mode: "report" } } })
				.settings,
		).toEqual({ enabled: false, intervalSec: 900, mode: "report" });
		expect(parseProcessReaperSettings({ processes: { reaper: { intervalSec: 1 } } }).settings.intervalSec).toBe(30);
		expect(parseProcessReaperSettings({ processes: { reaper: { intervalSec: "soon" } } }).settings.intervalSec).toBe(
			300,
		);
	});

	it("only reports when the mode is not one of the two values", () => {
		const parsed = parseProcessReaperSettings({ processes: { reaper: { mode: "nuke" } } });

		expect(parsed.settings.mode).toBe("report");
		expect(parsed.warning).toContain('"nuke"');
	});

	it("uses the defaults for a missing file and only reports when the file can't be parsed or read", async () => {
		const { path, cleanup } = createTempDir("kanban-reaper-config-");
		try {
			const configPath = join(path, "config.json");
			expect(await readProcessReaperSettings(configPath)).toEqual({
				settings: DEFAULT_PROCESS_REAPER_SETTINGS,
				warning: null,
			});

			writeFileSync(configPath, "{ not json");
			const broken = await readProcessReaperSettings(configPath);
			expect(broken.settings).toEqual({ ...DEFAULT_PROCESS_REAPER_SETTINGS, mode: "report" });
			expect(broken.warning).toContain("Could not parse");

			const directoryPath = join(path, "dir.json");
			mkdirSync(directoryPath);
			const unreadable = await readProcessReaperSettings(directoryPath);
			expect(unreadable.settings.mode).toBe("report");
			expect(unreadable.warning).toContain("Could not read");

			writeFileSync(configPath, JSON.stringify({ home: 1, processes: { reaper: { mode: "report" } } }));
			expect((await readProcessReaperSettings(configPath)).settings.mode).toBe("report");
		} finally {
			cleanup();
		}
	});

	it("logs each distinct fallback warning once", async () => {
		const { path, cleanup } = createTempDir("kanban-reaper-config-");
		try {
			const configPath = join(path, "config.json");
			writeFileSync(configPath, "{ not json");
			const warn = vi.fn();
			const load = createProcessReaperSettingsLoader(warn, configPath);

			expect((await load()).mode).toBe("report");
			await load();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toMatch(/^\[process-reaper\] Could not parse/u);

			writeFileSync(configPath, "{}");
			expect((await load()).mode).toBe("terminate");
			writeFileSync(configPath, "{ broken again");
			await load();
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			cleanup();
		}
	});
});
