// A paste as xterm.js 6 sends it (src/browser/Clipboard.ts `paste`): line
// breaks become CR and the text is bracketed (ESC[200~ … ESC[201~) while the
// TUI has bracketed paste on (DECSET 2004), so it takes the text as one paste,
// not as typed keys. xterm's own paste() also empties its textarea afterwards,
// which a dictating phone keyboard must never see (terminal-ime-input.ts), so
// on a phone the manager sends this through the IME input instead.

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function encodeTerminalPaste(text: string, bracketedPasteMode: boolean): string {
	const prepared = text.replace(/\r?\n/g, "\r");
	return bracketedPasteMode ? `${PASTE_START}${prepared}${PASTE_END}` : prepared;
}
