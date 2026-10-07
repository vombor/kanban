import { describe, expect, it } from "vitest";

import { DEFAULT_REVIEW_SETTLE_MS, isReviewSettled } from "../../../src/terminal/review-settle";

const T0 = Date.parse("2026-10-07T10:00:00.000Z");

describe("isReviewSettled", () => {
	it("waits the settle period (12 s by default) after the session entered Review", () => {
		expect(DEFAULT_REVIEW_SETTLE_MS).toBe(12_000);
		const review = { state: "awaiting_review" as const, stateChangedAt: T0 };
		expect(isReviewSettled(review, T0 + 100)).toBe(false);
		expect(isReviewSettled(review, T0 + 11_999)).toBe(false);
		expect(isReviewSettled(review, T0 + 12_000)).toBe(true);
		expect(isReviewSettled(review, T0 + 5_000, 5_000)).toBe(true);
		expect(isReviewSettled(review, T0, 0)).toBe(true);
	});

	it("is never settled while running, and restarts the clock on every new Review (the 6 s late turn)", () => {
		expect(isReviewSettled({ state: "running", stateChangedAt: T0 }, T0 + 60_000)).toBe(false);
		// Final agentStop at T0, a background shell starts a turn at T0 + 6 s, which ends at T0 + 20 s.
		expect(isReviewSettled({ state: "awaiting_review", stateChangedAt: T0 }, T0 + 5_900)).toBe(false);
		expect(isReviewSettled({ state: "running", stateChangedAt: T0 + 6_000 }, T0 + 12_000)).toBe(false);
		const late = { state: "awaiting_review" as const, stateChangedAt: T0 + 20_000 };
		expect(isReviewSettled(late, T0 + 31_999)).toBe(false);
		expect(isReviewSettled(late, T0 + 32_000)).toBe(true);
	});

	it("counts hook activity and a session start in Review as activity, but not output", () => {
		const base = { state: "awaiting_review" as const, stateChangedAt: T0 };
		expect(isReviewSettled({ ...base, lastHookAt: T0 + 8_000 }, T0 + 12_000)).toBe(false);
		expect(isReviewSettled({ ...base, lastHookAt: T0 + 8_000 }, T0 + 20_000)).toBe(true);
		expect(isReviewSettled({ ...base, startedAt: T0 + 3_000 }, T0 + 12_000)).toBe(false);
		expect(isReviewSettled({ ...base, lastOutputAt: T0 + 11_000 } as typeof base, T0 + 12_000)).toBe(true);
	});

	it("is settled with no session, another state, or a summary without stateChangedAt", () => {
		expect(isReviewSettled(null, T0)).toBe(true);
		expect(isReviewSettled(undefined, T0)).toBe(true);
		expect(isReviewSettled({ state: "interrupted", stateChangedAt: T0 }, T0)).toBe(true);
		expect(isReviewSettled({ state: "idle", stateChangedAt: T0 }, T0)).toBe(true);
		expect(isReviewSettled({ state: "awaiting_review", lastHookAt: T0 }, T0)).toBe(true);
		expect(isReviewSettled({ state: "awaiting_review", stateChangedAt: null }, T0)).toBe(true);
	});
});
