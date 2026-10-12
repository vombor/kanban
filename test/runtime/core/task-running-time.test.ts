import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	accumulateRunningTime,
	formatRunningDuration,
	readTaskRunningTime,
	type TaskRunningTimeSummary,
} from "../../../src/core/task-running-time";

function summary(patch: Partial<TaskRunningTimeSummary>): TaskRunningTimeSummary {
	return { state: "idle", startedAt: null, stateChangedAt: null, updatedAt: 0, ...patch };
}

describe("accumulateRunningTime", () => {
	it("adds a running span when the state changes or a new run starts", () => {
		const running = summary({ state: "running", startedAt: 1_000, stateChangedAt: 1_000, updatedAt: 1_500 });
		expect(accumulateRunningTime(running, { state: "awaiting_review" }, 61_000, { live: true })).toEqual({
			runningMs: 60_000,
		});
		expect(
			accumulateRunningTime({ ...running, runningMs: 5_000 }, { startedAt: 30_000 }, 30_000, { live: true }),
		).toEqual({ runningMs: 34_000 });
	});

	it("counts from the later of the state change and the run's start", () => {
		const resumed = summary({ state: "running", startedAt: 10_000, stateChangedAt: 4_000, updatedAt: 0 });
		expect(accumulateRunningTime(resumed, { state: "idle" }, 12_000, { live: true })).toEqual({ runningMs: 2_000 });
	});

	it("ends a span without a process at the summary's last update, not after the downtime", () => {
		const orphan = summary({ state: "running", startedAt: 1_000, stateChangedAt: 1_000, updatedAt: 9_000 });
		expect(accumulateRunningTime(orphan, { state: "interrupted" }, 3_600_000, { live: false })).toEqual({
			runningMs: 8_000,
		});
	});

	it("leaves the total alone outside running and for patches that don't end the span", () => {
		const review = summary({ state: "awaiting_review", runningMs: 7_000, stateChangedAt: 1_000 });
		expect(accumulateRunningTime(review, { state: "running" }, 5_000, { live: true })).toBeNull();
		const running = summary({ state: "running", startedAt: 1_000, stateChangedAt: 1_000 });
		const outputOnly: Partial<RuntimeTaskSessionSummary> = { lastOutputAt: 2_000 };
		expect(accumulateRunningTime(running, outputOnly, 2_000, { live: true })).toBeNull();
		expect(accumulateRunningTime(running, { state: "running" }, 2_000, { live: true })).toBeNull();
	});
});

describe("readTaskRunningTime", () => {
	it("adds the live span while running", () => {
		const time = readTaskRunningTime(
			summary({
				state: "running",
				startedAt: 100_000,
				stateChangedAt: 100_000,
				runningMs: 60_000,
				runCount: 2,
				firstRunStartedAt: 1_000,
			}),
			130_000,
		);
		expect(time).toEqual({ totalMs: 90_000, runningSince: 100_000, runCount: 2, firstRunStartedAt: 1_000 });
	});

	it("is the finished total in Review, and null for a card whose agent never ran", () => {
		expect(readTaskRunningTime(summary({ state: "awaiting_review", runningMs: 5_000, runCount: 1 }), 99_999)).toEqual(
			{
				totalMs: 5_000,
				runningSince: null,
				runCount: 1,
				firstRunStartedAt: null,
			},
		);
		expect(readTaskRunningTime(summary({ state: "idle" }), 1)).toBeNull();
		expect(readTaskRunningTime(undefined, 1)).toBeNull();
	});
});

describe("formatRunningDuration", () => {
	it("formats seconds, minutes and hours compactly", () => {
		expect(formatRunningDuration(0)).toBe("0s");
		expect(formatRunningDuration(45_900)).toBe("45s");
		expect(formatRunningDuration(12 * 60_000 + 59_000)).toBe("12m");
		expect(formatRunningDuration(65 * 60_000)).toBe("1h 05m");
		expect(formatRunningDuration(26 * 3_600_000 + 7 * 60_000)).toBe("26h 07m");
		expect(formatRunningDuration(-5)).toBe("0s");
	});
});
