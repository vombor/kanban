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
 * A calibration is finished when its state says so (`finishedAt`, `kanban bench calibrate`). A legacy kit state (no
 * `version`) has no such field; its runner wrote results.md at the end, so that counts there.
 */
async function isFinishedCalibration(dir: string, state: unknown): Promise<boolean> {
	if (state && typeof state === "object" && "version" in state) {
		return Boolean((state as { finishedAt?: unknown }).finishedAt);
	}
	return await exists(join(dir, "results.md"));
}

/**
 * Card ids of calibration runs (`<calibrationDir>/<name>/state.json` `runs.*.id`). `onlyUnfinished`: only runs of
 * calibrations that are not finished yet (isFinishedCalibration).
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
		const state = await readJson(join(dir, "state.json"));
		if (options.onlyUnfinished && (await isFinishedCalibration(dir, state))) {
			continue;
		}
		for (const id of runIdsOf(state)) {
			ids.add(id);
		}
	}
	return ids;
}

/** Card ids of runoff groups that are still open: not decided and not abandoned (`runoffs.json` `runoffs[]`). */
export async function readUndecidedRunoffCardIds(runoffsPath: string): Promise<Set<string>> {
	const ids = new Set<string>();
	const document = await readJson(runoffsPath);
	const runoffs = document && typeof document === "object" ? (document as { runoffs?: unknown }).runoffs : undefined;
	for (const runoff of Array.isArray(runoffs) ? runoffs : []) {
		if (
			!runoff ||
			typeof runoff !== "object" ||
			(runoff as { decided?: unknown }).decided ||
			(runoff as { abandoned?: unknown }).abandoned
		) {
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
