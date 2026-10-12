// What a write into a task's terminal says about the TUI's input box (issue #39).
//
// A viewer's terminal (xterm.js in the browser) writes more than keys: replies to the agent's queries (OSC 10/11
// colors `ESC ] 11;rgb:… ESC \`, DA/XTVERSION, cursor reports), focus and mouse reports, paste brackets. Only
// printable text the user typed can leave a draft in the input box; everything else is stripped first, or a reply's
// payload (`11;rgb:…`) or an SGR mouse report (`<0;10;20M`) reads as a draft no Enter ever clears.

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: these match terminal control sequences.
/** OSC, DCS, SOS, PM and APC strings (7- and 8-bit introducers), up to BEL or ST, or to the end of an unfinished one. */
const STRING_SEQUENCE =
	/(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c|$)/gu;
/** X10 mouse report: `ESC [ M` and three raw bytes, which would otherwise read as printable text. */
const X10_MOUSE = /\u001b\[M[\s\S]{0,3}/gu;
/** CSI (ECMA-48: parameter bytes, intermediate bytes, final byte), 7- and 8-bit. */
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/gu;
/** SS2/SS3 (application keypad and cursor keys) and the other `ESC [intermediates] final` forms. */
const ESC_SEQUENCE = /\u001b(?:[NO][\s\S]|[ -/]*[0-~])?/gu;
/** Control characters that are no text (Enter, Ctrl-C and Ctrl-U are read before this). */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Keys after which the input line is empty: Enter submits it, Ctrl-C and Ctrl-U clear it. */
const LINE_CLEARING_KEY = /[\r\n\u0003\u0015]/u;
const LAST_LINE_CLEARING_KEY = /[\r\n\u0003\u0015](?![\s\S]*[\r\n\u0003\u0015])/u;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: these match terminal control sequences.

export interface TypedInputChunk {
	/** Something the user pressed: anything but terminal sequences (Enter, Backspace and Ctrl keys included). */
	hasKeys: boolean;
	/** An Enter (CR or LF). */
	submitted: boolean;
	/** Enter, Ctrl-C or Ctrl-U: the input line is empty after it, unless `typesDraft`. */
	cleared: boolean;
	/** Printable text was typed (after the last clearing key, when there is one), so the input box holds a draft. */
	typesDraft: boolean;
}

function stripTerminalSequences(text: string): string {
	return text.replace(STRING_SEQUENCE, "").replace(X10_MOUSE, "").replace(CSI_SEQUENCE, "").replace(ESC_SEQUENCE, "");
}

export function readTypedInput(data: string): TypedInputChunk {
	const keys = stripTerminalSequences(data);
	const cleared = LINE_CLEARING_KEY.test(keys);
	const lastClear = cleared ? keys.search(LAST_LINE_CLEARING_KEY) : -1;
	const tail = keys.slice(lastClear + 1).replace(CONTROL_CHARACTERS, "");
	return {
		hasKeys: keys.length > 0,
		submitted: /[\r\n]/u.test(keys),
		cleared,
		// Blanks right after an Enter are no draft (`text\r\n` and the like).
		typesDraft: cleared ? tail.trim().length > 0 : tail.length > 0,
	};
}
