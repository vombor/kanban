import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stripReworkSections } from "../../../../src/kits/team/calibration/calibration-prompt";
import {
	getCalibrationSetRef,
	listCalibrationRuns,
	parseCalibrationSpec,
} from "../../../../src/kits/team/calibration/calibration-spec";
import { readCalibrationRunIds } from "../../../../src/pipeline/watchdog/workspace-data";
import { createTempDir } from "../../../utilities/temp-dir";

// The shape of the legacy kit's data/foo/calibration/qa-models-v12/spec.json (10/06).
const LEGACY_SPEC = {
	name: "qa-models-v12",
	workspace: "foo",
	parallel: 3,
	timeoutMin: 60,
	sets: [
		{ id: "A", ref: "0d1b26d", base: "2ca0882", fromCard: "f80db", expect: "FAIL", note: "f80db frontend auth" },
		{ id: "B", ref: "0167450", base: "1c8c397", fromCard: "2c0d7", expect: "PASS", note: "2c0d7 logout fix" },
	],
	models: [{ key: "nova2lite-cline3", agent: "cline", provider: "bedrock", model: "us.amazon.nova-2-lite-v1:0" }],
	maxNudges: 6,
	maxCostUSD: 10,
	loopRepeats: 25,
};

const tempDirs: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	for (const temp of tempDirs.splice(0)) {
		temp.cleanup();
	}
});

describe("calibration spec", () => {
	it("parses a legacy kit spec, with the legacy defaults for what it leaves out", () => {
		const spec = parseCalibrationSpec({ ...LEGACY_SPEC, models: [{ key: "sol", agent: "cline-cli" }] });
		expect(spec).toMatchObject({ name: "qa-models-v12", parallel: 3, maxNudges: 6, maxCostUSD: 10, loopRepeats: 25 });
		// "cline-cli" was the CLI agent's id while the embedded agent existed.
		expect(spec.models[0]).toMatchObject({ agent: "cline", rules: [] });
		const defaults = parseCalibrationSpec({ name: "x", sets: LEGACY_SPEC.sets, models: LEGACY_SPEC.models });
		expect(defaults).toMatchObject({ parallel: 3, timeoutMin: 75, maxNudges: 2, loopRepeats: 25, maxCostUSD: 10 });
	});

	it("rejects unknown agents, duplicate keys and names that can't be a path or ref", () => {
		expect(() => parseCalibrationSpec({ ...LEGACY_SPEC, models: [{ key: "x", agent: "gpt" }] })).toThrow(
			/models\.0\.agent/u,
		);
		expect(() => parseCalibrationSpec({ ...LEGACY_SPEC, sets: [LEGACY_SPEC.sets[0], LEGACY_SPEC.sets[0]] })).toThrow(
			/"A" is listed twice/u,
		);
		expect(() => parseCalibrationSpec({ ...LEGACY_SPEC, name: "../x" })).toThrow(/name/u);
		expect(() => parseCalibrationSpec({ ...LEGACY_SPEC, sets: [] })).toThrow(/sets/u);
	});

	it("lists runs set by set, so a wave is one set across all models", () => {
		const spec = parseCalibrationSpec({
			...LEGACY_SPEC,
			models: [
				{ key: "sol", agent: "codex" },
				{ key: "haiku", agent: "cline" },
			],
		});
		expect(listCalibrationRuns(spec).map((run) => run.key)).toEqual(["A-sol", "A-haiku", "B-sol", "B-haiku"]);
		expect(getCalibrationSetRef(spec, spec.sets[1] ?? LEGACY_SPEC.sets[1])).toBe(
			"refs/kanban/calibration/qa-models-v12-B",
		);
	});

	it("strips REWORK rounds from the dev prompt up to its FINAL STEP", () => {
		const prompt = "Build it.\n\nREWORK round 2: fix the login.\n- a\n\nFINAL STEP: reply STATUS.";
		expect(stripReworkSections(prompt)).toBe("Build it.\n\nFINAL STEP: reply STATUS.");
		expect(stripReworkSections("Build it.\n\nREWORK round 1: more")).toBe("Build it.");
	});
});

describe("finished calibrations (watchdog, prune-done)", () => {
	async function writeRun(root: string, name: string, state: unknown, resultsMd: boolean): Promise<void> {
		await mkdir(join(root, name), { recursive: true });
		await writeFile(join(root, name, "state.json"), JSON.stringify(state));
		if (resultsMd) {
			await writeFile(join(root, name, "results.md"), "# results\n");
		}
	}

	it("reads finishedAt for the runner's states and results.md for the legacy kit's", async () => {
		const temp = createTempDir("kanban-calibration-ids-");
		tempDirs.push(temp);
		const root = temp.path;
		// The runner writes results.md from the start: only finishedAt ends it.
		await writeRun(root, "new-running", { version: 1, finishedAt: null, runs: { a: { id: "aaaaa" } } }, true);
		await writeRun(
			root,
			"new-done",
			{ version: 1, finishedAt: "2026-10-07T10:00:00Z", runs: { b: { id: "bbbbb" } } },
			true,
		);
		await writeRun(root, "legacy-running", { runs: { c: { id: "ccccc" } } }, false);
		await writeRun(root, "legacy-done", { runs: { d: { id: "ddddd" } } }, true);
		expect(await readCalibrationRunIds(root, { onlyUnfinished: true })).toEqual(new Set(["aaaaa", "ccccc"]));
		expect(await readCalibrationRunIds(root)).toEqual(new Set(["aaaaa", "bbbbb", "ccccc", "ddddd"]));
	});
});
