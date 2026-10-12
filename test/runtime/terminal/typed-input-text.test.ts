import { describe, expect, it } from "vitest";

import { readTypedInput } from "../../../src/terminal/typed-input-text";

describe("readTypedInput (issue #39)", () => {
	it("reads no draft from a terminal's replies, focus, mouse and key sequences", () => {
		const nonText = [
			"\u001b]11;rgb:1f1f/2424/2828\u001b\\", // OSC 11 color reply, ST
			"\u001b]10;rgb:e6e6/eded/f3f3\u0007", // OSC 10 color reply, BEL
			"\u001bP>|xterm.js(5.5.0)\u001b\\", // XTVERSION (DCS)
			"\u001b_Gi=1;OK\u001b\\", // APC (kitty graphics answer)
			"\u001b[?1;2c", // DA1
			"\u001b[>0;276;0c", // DA2
			"\u001b[12;40R", // cursor position report
			"\u001b[<0;10;20M\u001b[<0;10;20m", // SGR mouse press and release
			"\u001b[M !!", // X10 mouse
			"\u001b[I\u001b[O", // focus in/out
			"\u001bOA\u001b[B\u001b[1;5C", // arrows (SS3 and CSI)
			"\u001b[200~\u001b[201~", // empty bracketed paste
			"\u001b]11;rgb:1f1f", // OSC cut at the end of a write
			"\u007f\u0008\t\u001b", // Backspace, Tab, Esc
		];
		for (const data of nonText) {
			expect(readTypedInput(data), JSON.stringify(data)).toMatchObject({ typesDraft: false, submitted: false });
		}
		expect(readTypedInput("\u001b]11;rgb:1f1f/2424/2828\u001b\\").hasKeys).toBe(false);
		expect(readTypedInput("\u007f").hasKeys).toBe(true);
	});

	it("reads printable text as a draft and an Enter, Ctrl-C or Ctrl-U as the end of one", () => {
		expect(readTypedInput("h")).toEqual({ hasKeys: true, submitted: false, cleared: false, typesDraft: true });
		expect(readTypedInput(" ")).toMatchObject({ typesDraft: true });
		expect(readTypedInput("\u001b[200~pasted text\u001b[201~")).toMatchObject({ typesDraft: true });
		expect(readTypedInput("\u001b]11;rgb:1f1f/2424/2828\u001b\\x")).toMatchObject({ typesDraft: true });
		expect(readTypedInput("hello\r")).toEqual({ hasKeys: true, submitted: true, cleared: true, typesDraft: false });
		expect(readTypedInput("hello\r\n  ")).toMatchObject({ cleared: true, typesDraft: false });
		expect(readTypedInput("one\rtwo")).toMatchObject({ submitted: true, cleared: true, typesDraft: true });
		expect(readTypedInput("\u0003")).toEqual({ hasKeys: true, submitted: false, cleared: true, typesDraft: false });
		expect(readTypedInput("\u0015")).toMatchObject({ submitted: false, cleared: true, typesDraft: false });
	});
});
