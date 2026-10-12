import { describe, expect, it } from "vitest";

import { encodeTerminalTouchKey, TERMINAL_TOUCH_KEYS } from "@/terminal/terminal-touch-keys";

describe("encodeTerminalTouchKey", () => {
	it("sends arrows as CSI in normal cursor-key mode", () => {
		expect(TERMINAL_TOUCH_KEYS.slice(0, 4).map((key) => encodeTerminalTouchKey(key, false))).toEqual([
			"\x1b[A",
			"\x1b[B",
			"\x1b[D",
			"\x1b[C",
		]);
	});

	it("sends arrows as SS3 in application cursor-key mode (DECCKM)", () => {
		expect(encodeTerminalTouchKey("up", true)).toBe("\x1bOA");
		expect(encodeTerminalTouchKey("down", true)).toBe("\x1bOB");
		expect(encodeTerminalTouchKey("left", true)).toBe("\x1bOD");
		expect(encodeTerminalTouchKey("right", true)).toBe("\x1bOC");
	});

	it("sends the other keys the same in both modes", () => {
		for (const applicationCursorKeys of [false, true]) {
			expect(encodeTerminalTouchKey("tab", applicationCursorKeys)).toBe("\t");
			expect(encodeTerminalTouchKey("shiftTab", applicationCursorKeys)).toBe("\x1b[Z");
			expect(encodeTerminalTouchKey("escape", applicationCursorKeys)).toBe("\x1b");
			expect(encodeTerminalTouchKey("space", applicationCursorKeys)).toBe(" ");
			expect(encodeTerminalTouchKey("enter", applicationCursorKeys)).toBe("\r");
		}
	});
});
