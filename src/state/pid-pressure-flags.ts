// The one reader of the PID pressure flags (src/pipeline/watchdog/pid-pressure.ts): new work (QA cards, calibration
// waves, restart resumes) is held while `pid-pressure` exists, and resuming started cards only in `pid-brownout`.
// Two writers until the cutover: the fork's watchdog (`<home>/run/pid-pressure`, `pid-brownout`) and the legacy kit's
// review-watch (`<kit run dir>/pid-pressure`, `pid-brownout`, only while its kit.config.json exists and
// review-watch owns them: it runs or isn't disabled). Either one counts. review-watch never removes its flags when it
// stops (archive/devteam-kit:services/review-watch.mjs@a2b4695: only its own tick clears them), so once the cutover
// switches it off a flag left behind would hold every QA card and restart resume for good. The pipeline worker never reads these files: the worker host sends the answer in every snapshot
// (`pidPressure`), and `kanban bench calibrate` reads it here.
import { access } from "node:fs/promises";
import { join } from "node:path";

import {
	getLegacyKitRunPath,
	type LegacyKitProcessProbe,
	legacyKitServiceOwns,
	readLegacyKitConfig,
	readLegacyKitServices,
} from "../config/legacy-kit-config";
import { getPidPressureFlagPaths } from "./kanban-home";

export interface PidPressureFlags {
	pressure: boolean;
	brownout: boolean;
}

export interface ReadPidPressureFlagsOptions {
	/** The fork's flag files (default getPidPressureFlagPaths()). */
	flagPaths?: { pressure: string; brownout: string };
	/**
	 * The legacy kit's run dir, or null for none (default: from its kit.config.json, when it exists and review-watch
	 * owns the flags).
	 */
	legacyRunPath?: string | null;
	/** How the default looks at review-watch's pid file (tests). */
	legacyProbe?: LegacyKitProcessProbe;
}

async function exists(path: string): Promise<boolean> {
	return await access(path).then(
		() => true,
		() => false,
	);
}

async function readLegacyRunPath(probe: LegacyKitProcessProbe | undefined): Promise<string | null> {
	const legacy = await readLegacyKitConfig();
	if (!legacy.raw) {
		return null;
	}
	const reviewWatch = readLegacyKitServices(legacy.raw, probe).find((service) => service.name === "review-watch");
	return legacyKitServiceOwns(reviewWatch, true) ? getLegacyKitRunPath(legacy.raw) : null;
}

export async function readPidPressureFlags(options: ReadPidPressureFlagsOptions = {}): Promise<PidPressureFlags> {
	const own = options.flagPaths ?? getPidPressureFlagPaths();
	const legacyRunPath =
		options.legacyRunPath === undefined ? await readLegacyRunPath(options.legacyProbe) : options.legacyRunPath;
	const pressurePaths = [own.pressure, ...(legacyRunPath ? [join(legacyRunPath, "pid-pressure")] : [])];
	const brownoutPaths = [own.brownout, ...(legacyRunPath ? [join(legacyRunPath, "pid-brownout")] : [])];
	const [pressure, brownout] = await Promise.all([
		Promise.all(pressurePaths.map(exists)),
		Promise.all(brownoutPaths.map(exists)),
	]);
	const brownoutOn = brownout.some(Boolean);
	// Brownout is the higher level: the watchdog always writes both, so a lone brownout flag still means pressure.
	return { pressure: brownoutOn || pressure.some(Boolean), brownout: brownoutOn };
}
