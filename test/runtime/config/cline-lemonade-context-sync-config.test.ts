import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createClineLemonadeContextSyncSettingsLoader,
	parseClineLemonadeContextSyncSettings,
	readClineLemonadeContextSyncSettings,
} from "../../../src/config/cline-lemonade-context-sync-config";
import { createTempDir } from "../../utilities/temp-dir";

describe("agents.cline.lemonadeContextSync", () => {
	let dir: { path: string; cleanup: () => void };

	beforeEach(() => {
		dir = createTempDir("kanban-lemonade-sync-config-");
	});

	afterEach(() => {
		dir.cleanup();
	});

	it("is on every 30 s by default, and takes the mode, interval (at least 5 s) and Cline's data dir", () => {
		expect(parseClineLemonadeContextSyncSettings({}).settings).toMatchObject({ mode: "on", intervalSec: 30 });
		const parsed = parseClineLemonadeContextSyncSettings({
			agents: { cline: { dataDir: "/data/cline", lemonadeContextSync: { mode: "off", intervalSec: 1 } } },
		});
		expect(parsed).toEqual({ settings: { mode: "off", intervalSec: 5, dataDir: "/data/cline" }, warning: null });
	});

	it("only reports with a mode it doesn't know or a config.json it can't parse, and warns once", async () => {
		const unknown = parseClineLemonadeContextSyncSettings({
			agents: { cline: { lemonadeContextSync: { mode: "always" } } },
		});
		expect(unknown.settings.mode).toBe("report");
		expect(unknown.warning).toContain('"always" is not "off", "report" or "on"');

		const configPath = join(dir.path, "config.json");
		expect((await readClineLemonadeContextSyncSettings(configPath)).settings.mode).toBe("on");
		writeFileSync(configPath, "{ broken");
		const broken = await readClineLemonadeContextSyncSettings(configPath);
		expect(broken.settings.mode).toBe("report");
		const warnings: string[] = [];
		const load = createClineLemonadeContextSyncSettingsLoader((message) => warnings.push(message), configPath);
		await load();
		await load();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[cline-lemonade-sync] Could not parse");
	});
});
