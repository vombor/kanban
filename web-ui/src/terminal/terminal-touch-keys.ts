// The keys of the touch bar (terminal-touch-bar.tsx): what a phone keyboard
// lacks to answer an agent TUI's pickers (arrows, Tab, Shift+Tab, Esc), plus
// Enter, which a dictating keyboard may swallow or end its voice input on.

export const TERMINAL_TOUCH_KEYS = ["up", "down", "left", "right", "tab", "shiftTab", "escape", "enter"] as const;

export type TerminalTouchKey = (typeof TERMINAL_TOUCH_KEYS)[number];

const ARROW_FINAL: Record<"up" | "down" | "right" | "left", string> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
};

export function isTerminalArrowKey(key: TerminalTouchKey): key is keyof typeof ARROW_FINAL {
	return key in ARROW_FINAL;
}

// Arrows follow the terminal's cursor-key mode (DECCKM), as xterm sends them
// for a real key: `ESC O A` in application mode, `ESC [ A` otherwise.
export function encodeTerminalTouchKey(key: TerminalTouchKey, applicationCursorKeys: boolean): string {
	if (isTerminalArrowKey(key)) {
		return `${applicationCursorKeys ? "\x1bO" : "\x1b["}${ARROW_FINAL[key]}`;
	}
	switch (key) {
		case "tab":
			return "\t";
		case "shiftTab":
			return "\x1b[Z";
		case "escape":
			return "\x1b";
		case "enter":
			return "\r";
	}
}
