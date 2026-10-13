import { describe, expect, it } from "vitest";

import { formatLocalTime, formatTextTimes } from "@/utils/format-local-time";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const BERLIN = { now: NOW, locale: "en-GB", timeZone: "Europe/Berlin" };

describe("formatLocalTime", () => {
	it("shows only the time for an instant today in the viewer's time zone", () => {
		expect(formatLocalTime(Date.parse("2026-10-13T05:03:00.000Z"), BERLIN)).toBe("07:03");
	});

	it("follows the locale's 12- or 24-hour clock", () => {
		const at = Date.parse("2026-10-13T19:03:00.000Z");
		expect(formatLocalTime(at, { now: NOW, locale: "en-US", timeZone: "America/New_York" })).toBe("03:03 PM");
		expect(formatLocalTime(at, { now: NOW, locale: "de-DE", timeZone: "Europe/Berlin" })).toBe("21:03");
	});

	it("adds the date when the instant is another day there", () => {
		// 23:30 UTC on the 12th is already the 13th in Berlin, and still the 12th in Los Angeles.
		const at = Date.parse("2026-10-12T23:30:00.000Z");
		expect(formatLocalTime(at, BERLIN)).toBe("01:30");
		expect(formatLocalTime(at, { now: NOW, locale: "en-US", timeZone: "America/Los_Angeles" })).toBe(
			"Oct 12, 04:30 PM",
		);
		expect(formatLocalTime(Date.parse("2026-10-11T08:00:00.000Z"), BERLIN)).toBe("11 Oct, 10:00");
	});

	it("adds the year when the instant is another year", () => {
		expect(formatLocalTime(Date.parse("2025-12-31T10:00:00.000Z"), BERLIN)).toBe("31 Dec 2025, 11:00");
	});
});

describe("formatTextTimes", () => {
	it("replaces each listed instant and keeps the other words", () => {
		const text = "held for runoff-1 since 2026-10-13T05:03:00.000Z (sent 2026-10-11T08:00:00.000Z)";
		expect(
			formatTextTimes(
				text,
				[
					{ text: "2026-10-13T05:03:00.000Z", at: Date.parse("2026-10-13T05:03:00.000Z") },
					{ text: "2026-10-11T08:00:00.000Z", at: Date.parse("2026-10-11T08:00:00.000Z") },
				],
				BERLIN,
			),
		).toBe("held for runoff-1 since 07:03 (sent 11 Oct, 10:00)");
	});

	it("leaves a text without instants as it is", () => {
		expect(formatTextTimes("2 card(s) ahead", [], BERLIN)).toBe("2 card(s) ahead");
	});
});
