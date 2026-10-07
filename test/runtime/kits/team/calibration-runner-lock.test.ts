import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	acquireCalibrationRunnerLock,
	CalibrationRunnerBusyError,
} from "../../../../src/kits/team/calibration/calibration-runner-lock";
import { createTempDir } from "../../../utilities/temp-dir";

const tempDirs: Array<{ cleanup: () => void }> = [];

function createLockPath(): string {
	const temp = createTempDir("kanban-calibration-lock-");
	tempDirs.push(temp);
	return join(temp.path, "runner.pid");
}

afterEach(() => {
	for (const temp of tempDirs.splice(0)) {
		temp.cleanup();
	}
});

/** Runners started at the same moment, each with its own pid; all of them alive. */
async function raceRunners(lockPath: string, pids: number[], isAlive: (pid: number) => boolean) {
	return await Promise.allSettled(pids.map((pid) => acquireCalibrationRunnerLock(lockPath, { pid, isAlive })));
}

describe("acquireCalibrationRunnerLock", () => {
	it("lets exactly one of several runners started at the same moment take a free lock", async () => {
		const lockPath = createLockPath();
		const pids = [101, 102, 103, 104, 105, 106];
		const results = await raceRunners(lockPath, pids, () => true);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const holder = Number((await readFile(lockPath, "utf8")).trim());
		expect(pids[results.findIndex((result) => result.status === "fulfilled")]).toBe(holder);
		for (const result of results) {
			if (result.status === "rejected") {
				expect(result.reason).toBeInstanceOf(CalibrationRunnerBusyError);
				expect((result.reason as CalibrationRunnerBusyError).pid).toBe(holder);
			}
		}
		// No temporary files left beside the lock.
		expect((await readdir(join(lockPath, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("lets exactly one of several runners take over a dead runner's lock", async () => {
		const lockPath = createLockPath();
		await writeFile(lockPath, "99\n");
		const results = await raceRunners(lockPath, [201, 202, 203, 204], (pid) => pid !== 99);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect([201, 202, 203, 204]).toContain(Number((await readFile(lockPath, "utf8")).trim()));
	});

	it("takes over an empty or garbled lock", async () => {
		const lockPath = createLockPath();
		await writeFile(lockPath, "not a pid\n");
		await acquireCalibrationRunnerLock(lockPath, { pid: 301, isAlive: () => true });
		expect(await readFile(lockPath, "utf8")).toBe("301\n");
	});

	it("refuses a live holder, but a worker inherits the lock of the command that spawned it", async () => {
		const lockPath = createLockPath();
		const parent = await acquireCalibrationRunnerLock(lockPath, { pid: 401, isAlive: () => true });
		await expect(acquireCalibrationRunnerLock(lockPath, { pid: 402, isAlive: () => true })).rejects.toThrow(
			`already running (pid 401, ${lockPath})`,
		);
		const worker = await acquireCalibrationRunnerLock(lockPath, {
			pid: 403,
			inheritFrom: [401],
			isAlive: () => true,
		});
		expect(await readFile(lockPath, "utf8")).toBe("403\n");
		// The parent no longer holds it: its hand-over and release leave the worker's lock alone.
		await parent.handOver(403);
		await parent.release();
		expect(await readFile(lockPath, "utf8")).toBe("403\n");
		await worker.release();
		await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("hands the lock over to the detached worker's pid", async () => {
		const lockPath = createLockPath();
		const lock = await acquireCalibrationRunnerLock(lockPath, { pid: 501, isAlive: () => true });
		await lock.handOver(502);
		expect(await readFile(lockPath, "utf8")).toBe("502\n");
		await expect(acquireCalibrationRunnerLock(lockPath, { pid: 503, isAlive: () => true })).rejects.toThrow(
			"already running (pid 502",
		);
	});
});
