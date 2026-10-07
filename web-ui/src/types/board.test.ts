import { describe, expect, it } from "vitest";

import {
	getTaskAutoReviewActionLabel,
	getTaskAutoReviewCancelButtonLabel,
	getTaskAutoReviewModeOptions,
	getTaskRoleBadgeLabel,
	normalizeTaskRole,
	resolveTaskAutoReviewMode,
} from "@/types";

describe("getTaskAutoReviewActionLabel", () => {
	it("returns the expected label for each auto review mode", () => {
		expect(getTaskAutoReviewActionLabel("commit")).toBe("commit");
		expect(getTaskAutoReviewActionLabel("pr")).toBe("PR");
	});

	it("falls back to commit when the mode is missing", () => {
		expect(getTaskAutoReviewActionLabel(undefined)).toBe("commit");
	});

	it("returns the expected cancel button label for each auto review mode", () => {
		expect(getTaskAutoReviewCancelButtonLabel("commit")).toBe("Cancel Auto-commit");
		expect(getTaskAutoReviewCancelButtonLabel("pr")).toBe("Cancel Auto-PR");
	});
});

describe("the qa auto-review mode", () => {
	it("keeps qa as a mode and labels it", () => {
		expect(resolveTaskAutoReviewMode("qa")).toBe("qa");
		expect(getTaskAutoReviewActionLabel("qa")).toBe("QA and land");
		expect(getTaskAutoReviewCancelButtonLabel("qa")).toBe("Cancel QA and land");
	});

	it("offers qa only on a landing-qa workspace, or for a card that already is qa", () => {
		const values = (options: Parameters<typeof getTaskAutoReviewModeOptions>[0]) =>
			getTaskAutoReviewModeOptions(options).map((option) => option.value);
		expect(values({ qaLandingAvailable: false })).toEqual(["commit", "pr"]);
		expect(values({ qaLandingAvailable: true })).toEqual(["commit", "pr", "qa"]);
		expect(values({ qaLandingAvailable: false, currentMode: "qa" })).toEqual(["commit", "pr", "qa"]);
	});
});

describe("card roles", () => {
	it("normalizes roles: dev and unknown values mean no role", () => {
		expect(normalizeTaskRole("qa")).toBe("qa");
		expect(normalizeTaskRole("calibration")).toBe("calibration");
		expect(normalizeTaskRole("dev")).toBeUndefined();
		expect(normalizeTaskRole("judge")).toBeUndefined();
		expect(normalizeTaskRole(3)).toBeUndefined();
		expect(getTaskRoleBadgeLabel("triage")).toBe("Triage");
		expect(getTaskRoleBadgeLabel(undefined)).toBeNull();
	});
});
