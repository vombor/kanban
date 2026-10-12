import { describe, expect, it } from "vitest";

import { encodeTerminalPaste } from "@/terminal/terminal-paste";

describe("encodeTerminalPaste", () => {
	it("sends line breaks as CR, like xterm's paste", () => {
		expect(encodeTerminalPaste("one\r\ntwo\nthree", false)).toBe("one\rtwo\rthree");
	});

	it("brackets the text while the TUI has bracketed paste on", () => {
		expect(encodeTerminalPaste("a\nb", true)).toBe("\x1b[200~a\rb\x1b[201~");
	});
});
