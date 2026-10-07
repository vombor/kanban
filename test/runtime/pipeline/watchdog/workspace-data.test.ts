import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readCalibrationRunIds } from "../../../../src/pipeline/watchdog/workspace-data";
import { createTempDir } from "../../../utilities/temp-dir";

const tempDirs: Array<{ cleanup: () => void }> = [];

afterEach(() => {
	for (const temp of tempDirs.splice(0)) {
		temp.cleanup();
	}
});

async function writeCalibration(name: string, state: unknown, options: { resultsMd: boolean }): Promise<string> {
	const temp = createTempDir("kanban-workspace-data-");
	tempDirs.push(temp);
	await mkdir(join(temp.path, name), { recursive: true });
	await writeFile(join(temp.path, name, "state.json"), JSON.stringify(state));
	if (options.resultsMd) {
		await writeFile(join(temp.path, name, "results.md"), "# results\n");
	}
	return temp.path;
}

/** The ids prune-done must keep (`onlyUnfinished`) for one calibration. */
async function unfinishedIds(state: unknown, options: { resultsMd: boolean }): Promise<string[]> {
	const root = await writeCalibration("cal", state, options);
	return [...(await readCalibrationRunIds(root, { onlyUnfinished: true }))];
}

describe("readCalibrationRunIds onlyUnfinished", () => {
	const runs = { "A-sol": { id: "aaaaa" }, "A-haiku": { id: "bbbbb", done: "2026-10-07T10:00:00Z" } };

	// `kanban bench calibrate` rewrites results.md from its first poll, so results.md must not end a versioned run:
	// prune-done would delete the cards of a calibration that is still running.
	it("keeps every card of a running calibration (version, no finishedAt), with or without results.md", async () => {
		for (const resultsMd of [false, true]) {
			expect(await unfinishedIds({ version: 1, finishedAt: null, runs }, { resultsMd })).toEqual(["aaaaa", "bbbbb"]);
			expect(await unfinishedIds({ version: 1, runs }, { resultsMd })).toEqual(["aaaaa", "bbbbb"]);
		}
	});

	it("releases the cards of a finished calibration (version, finishedAt set)", async () => {
		for (const resultsMd of [false, true]) {
			expect(await unfinishedIds({ version: 1, finishedAt: "2026-10-07T11:00:00Z", runs }, { resultsMd })).toEqual(
				[],
			);
		}
	});

	it("reads a legacy kit state (no version) as finished once results.md exists", async () => {
		expect(await unfinishedIds({ runs }, { resultsMd: false })).toEqual(["aaaaa", "bbbbb"]);
		expect(await unfinishedIds({ runs }, { resultsMd: true })).toEqual([]);
		// A legacy state never had finishedAt; one that has it without a version still goes by results.md.
		expect(await unfinishedIds({ finishedAt: "2026-10-07T11:00:00Z", runs }, { resultsMd: false })).toEqual([
			"aaaaa",
			"bbbbb",
		]);
	});

	it("lists every run id without onlyUnfinished", async () => {
		const root = await writeCalibration(
			"cal",
			{ version: 1, finishedAt: "2026-10-07T11:00:00Z", runs },
			{
				resultsMd: true,
			},
		);
		expect(await readCalibrationRunIds(root)).toEqual(new Set(["aaaaa", "bbbbb"]));
	});
});
