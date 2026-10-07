import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPidPressureFlagPaths } from "../../../src/state/kanban-home";
import { readPidPressureFlags } from "../../../src/state/pid-pressure-flags";

describe("readPidPressureFlags", () => {
	const savedEnv = { KANBAN_KIT_HOME: process.env.KANBAN_KIT_HOME, KIT_CONFIG: process.env.KIT_CONFIG };
	let root = "";
	let home = "";
	let kitHome = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kanban-pid-flags-"));
		home = join(root, "home");
		kitHome = join(root, "kit");
		mkdirSync(join(home, "run"), { recursive: true });
		mkdirSync(join(kitHome, "run"), { recursive: true });
		process.env.KANBAN_KIT_HOME = kitHome;
		delete process.env.KIT_CONFIG;
	});
	afterEach(() => {
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		rmSync(root, { recursive: true, force: true });
	});

	const flagPaths = () => getPidPressureFlagPaths(home);

	it("reads the watchdog's flags in the Kanban home; a lone brownout flag is pressure too", async () => {
		expect(await readPidPressureFlags({ flagPaths: flagPaths() })).toEqual({ pressure: false, brownout: false });
		writeFileSync(flagPaths().pressure, "800/1000\n");
		expect(await readPidPressureFlags({ flagPaths: flagPaths() })).toEqual({ pressure: true, brownout: false });
		rmSync(flagPaths().pressure);
		writeFileSync(flagPaths().brownout, "950/1000\n");
		expect(await readPidPressureFlags({ flagPaths: flagPaths() })).toEqual({ pressure: true, brownout: true });
	});

	it("also reads the legacy kit's flags while its kit.config.json exists, in its configured run dir", async () => {
		writeFileSync(join(kitHome, "run", "pid-pressure"), "");
		// No kit config: the legacy kit is not installed, its run dir is not read.
		expect((await readPidPressureFlags({ flagPaths: flagPaths() })).pressure).toBe(false);

		writeFileSync(join(kitHome, "kit.config.json"), JSON.stringify({}));
		expect((await readPidPressureFlags({ flagPaths: flagPaths() })).pressure).toBe(true);

		mkdirSync(join(root, "elsewhere"));
		writeFileSync(join(kitHome, "kit.config.json"), JSON.stringify({ runDir: join(root, "elsewhere") }));
		expect((await readPidPressureFlags({ flagPaths: flagPaths() })).pressure).toBe(false);
		writeFileSync(join(root, "elsewhere", "pid-brownout"), "");
		expect(await readPidPressureFlags({ flagPaths: flagPaths() })).toEqual({ pressure: true, brownout: true });
	});

	it("stops reading the legacy flags once review-watch is switched off: it leaves them behind when it stops", async () => {
		writeFileSync(join(kitHome, "kit.config.json"), JSON.stringify({}));
		writeFileSync(join(kitHome, "run", "pid-pressure"), "");
		writeFileSync(join(kitHome, "run", "review-watch.disabled"), "");
		const stopped = {
			readFile: (path: string) => (path.endsWith(".disabled") ? "" : null),
			isAlive: () => false,
			readCommandLine: () => null,
		};
		expect((await readPidPressureFlags({ flagPaths: flagPaths(), legacyProbe: stopped })).pressure).toBe(false);

		// Disabled but still running (not stopped yet): its flags still count.
		const running = {
			readFile: (path: string) =>
				path.endsWith(".disabled") ? "" : path.endsWith("review-watch.pid") ? "4242\n" : null,
			isAlive: (pid: number) => pid === 4242,
			readCommandLine: () => ["node", "/kit/services/review-watch.mjs"],
		};
		expect((await readPidPressureFlags({ flagPaths: flagPaths(), legacyProbe: running })).pressure).toBe(true);
		// The watchdog's own flags count either way.
		writeFileSync(flagPaths().pressure, "");
		expect((await readPidPressureFlags({ flagPaths: flagPaths(), legacyProbe: stopped })).pressure).toBe(true);
	});
});
