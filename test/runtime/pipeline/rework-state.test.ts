import { describe, expect, it } from "vitest";

import { isReworkAwaitingStart, REWORK_STARTED_CHECK_MS } from "../../../src/pipeline/rework-state";

const SENT = Date.parse("2026-10-07T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("a fresh rework belongs to the started-check", () => {
	it("before the restart: whatever its age (a slow or stopped worker runs the started-check late)", () => {
		const rework = { at: iso(SENT), startedAt: null, restartAt: null };
		expect(isReworkAwaitingStart(rework, SENT + 2 * REWORK_STARTED_CHECK_MS)).toBe(true);
		expect(isReworkAwaitingStart(rework, SENT + 60 * 60_000)).toBe(true);
	});

	it("after the restart: one window from the restart, so a late restart is not left to recovery mid-check", () => {
		// The started-check ran late (a slow tick) and restarted at 200 s; it escalates one window after that.
		const restartAt = SENT + 200_000;
		const rework = { at: iso(SENT), startedAt: null, restartAt: iso(restartAt) };
		expect(isReworkAwaitingStart(rework, SENT + 2 * REWORK_STARTED_CHECK_MS + 10_000)).toBe(true);
		expect(isReworkAwaitingStart(rework, restartAt + REWORK_STARTED_CHECK_MS)).toBe(false);
	});

	it("never once it started, or when there is none", () => {
		expect(isReworkAwaitingStart({ at: iso(SENT), startedAt: iso(SENT + 1000), restartAt: null }, SENT + 2000)).toBe(
			false,
		);
		expect(isReworkAwaitingStart(null, SENT)).toBe(false);
	});
});
