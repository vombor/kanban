import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	createClineTurnDetectorSettingsLoader,
	getDefaultClineTurnDetectorSettings,
	parseClineTurnDetectorSettings,
	readClineTurnDetectorSettings,
} from "../../../src/config/cline-turn-detector-config";
import { getClineDataPath } from "../../../src/state/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

describe("cline turn detector settings", () => {
	it("defaults to report-only every 15 s on Cline's data dir", () => {
		expect(parseClineTurnDetectorSettings({})).toEqual({
			settings: { mode: "report", intervalSec: 15, dataDir: getClineDataPath() },
			warning: null,
		});
		expect(getDefaultClineTurnDetectorSettings().mode).toBe("report");
	});

	it("reads agents.cline and clamps the interval", () => {
		expect(
			parseClineTurnDetectorSettings({
				agents: { cline: { dataDir: "~/cline-data", turnDetector: { mode: "on", intervalSec: 30 } } },
			}).settings,
		).toEqual({ mode: "on", intervalSec: 30, dataDir: join(homedir(), "cline-data") });
		expect(
			parseClineTurnDetectorSettings({ agents: { cline: { turnDetector: { intervalSec: 1 } } } }).settings
				.intervalSec,
		).toBe(5);
		expect(
			parseClineTurnDetectorSettings({ agents: { cline: { turnDetector: { mode: "off" } } } }).settings.mode,
		).toBe("off");
	});

	it("only reports when the mode is unknown or config.json is unreadable", async () => {
		const parsed = parseClineTurnDetectorSettings({ agents: { cline: { turnDetector: { mode: "always" } } } });
		expect(parsed.settings.mode).toBe("report");
		expect(parsed.warning).toContain('"always"');

		const temp = createTempDir("kanban-cline-detector-config-");
		try {
			const configPath = join(temp.path, "config.json");
			expect((await readClineTurnDetectorSettings(configPath)).warning).toBeNull();
			writeFileSync(configPath, "{ not json");
			const broken = await readClineTurnDetectorSettings(configPath);
			expect(broken.settings.mode).toBe("report");

			const warn = vi.fn();
			const load = createClineTurnDetectorSettingsLoader(warn, configPath);
			await load();
			await load();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			temp.cleanup();
		}
	});
});
