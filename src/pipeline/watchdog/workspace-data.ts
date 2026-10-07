// Reads of the per-workspace data files the watchdog and prune-done share: calibration runs and runoff groups. They
// are written by the team kit's calibration and runoffs features (and by the legacy kit until cutover), in the legacy
// kit's formats.
//
// Ported from archive/devteam-kit:lib/calibration.cjs@6da71597 (calibrationIds) and
// archive/devteam-kit:bin/prune-done.mjs@6da71597 (the keep set).
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

function runIdsOf(state: unknown): string[] {
	const runs = state && typeof state === "object" ? (state as { runs?: unknown }).runs : undefined;
	if (!runs || typeof runs !== "object") {
		return [];
	}
	return Object.values(runs as Record<string, unknown>).flatMap((run) => {
		const id = run && typeof run === "object" ? (run as { id?: unknown }).id : undefined;
		return typeof id === "string" && id ? [id] : [];
	});
}

/**
 * Card ids of calibration runs (`<calibrationDir>/<name>/state.json` `runs.*.id`). `onlyUnfinished`: only runs of
 * calibrations without a `results.md` yet (a finished calibration writes it).
 */
export async function readCalibrationRunIds(
	calibrationDir: string,
	options: { onlyUnfinished?: boolean } = {},
): Promise<Set<string>> {
	const ids = new Set<string>();
	let names: string[];
	try {
		names = await readdir(calibrationDir);
	} catch {
		return ids;
	}
	for (const name of names) {
		const dir = join(calibrationDir, name);
		if (options.onlyUnfinished && (await exists(join(dir, "results.md")))) {
			continue;
		}
		for (const id of runIdsOf(await readJson(join(dir, "state.json")))) {
			ids.add(id);
		}
	}
	return ids;
}

/** Card ids of runoff groups that are not decided yet (`runoffs.json` `runoffs[].{decided,cards[]}`). */
export async function readUndecidedRunoffCardIds(runoffsPath: string): Promise<Set<string>> {
	const ids = new Set<string>();
	const document = await readJson(runoffsPath);
	const runoffs = document && typeof document === "object" ? (document as { runoffs?: unknown }).runoffs : undefined;
	for (const runoff of Array.isArray(runoffs) ? runoffs : []) {
		if (!runoff || typeof runoff !== "object" || (runoff as { decided?: unknown }).decided) {
			continue;
		}
		const cards = (runoff as { cards?: unknown }).cards;
		for (const id of Array.isArray(cards) ? cards : []) {
			if (typeof id === "string") {
				ids.add(id);
			}
		}
	}
	return ids;
}
