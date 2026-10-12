// On-screen keyboard and dictation input for an agent terminal on a phone.
//
// xterm.js 6 assumes its hidden textarea only grows: CoreBrowserTerminal's
// _inputEvent forwards the data of every `insertText` input event that has no
// keydown, and no other input type (deleteContentBackward, insertReplacementText,
// ...) reaches the PTY. An IME that rewrites text it already committed (Gboard
// voice typing deletes its last interim result without a key event, then commits
// the next one; iOS dictation replaces its range) therefore sent every partial
// result again: "let me know" arrived as "llet let melet me know".
//
// So on a touch device the textarea's non-composition edits are ours: xterm
// never sees those input events (nor the keyCode 229 keydowns whose textarea
// diff it would send too), and the PTY gets the difference between what it
// already has and what the textarea holds now: Backspaces for what the IME took
// back, then the new text. An edit that removed text waits a moment for the
// replacement, so a rewritten partial reaches the PTY as just its new end.
//
// Compositions (xterm shows them at the cursor and sends them at
// compositionend) and real keys stay xterm's, as on desktop.
//
// Enter (the keyboard's, or the panel's Enter button through submit()) is ours
// too: xterm's Enter empties the textarea, and a keyboard whose text is changed
// under it ends its input session, voice typing included. Here the textarea
// keeps its text and what has been submitted is final: the diff only covers the
// PTY's current line (the text after the submitted part), so Backspaces never
// reach a prompt that has already been sent, and a later rewrite of a submitted
// hypothesis sends only what follows it.
//
// The panel's key bar (arrows, Tab, Esc, Space) goes through sendKey() the same
// way: the TUI acts on the key (moves its cursor, picks an option), so what has
// been dictated goes out first, the key after it, and that text is final too.

const DEL = "\x7f";
const ENTER = "\r";
const IME_KEY_CODE = 229;
const ENTER_KEY_CODE = 13;
// How long an IME edit that took text back waits for the text that replaces it.
export const IME_REWRITE_SETTLE_MS = 300;

export interface TextareaEditDiff {
	deleteCount: number;
	insert: string;
}

// By code point, so an emoji the IME took back is one Backspace.
export function diffTextareaEdit(synced: string, value: string): TextareaEditDiff {
	const before = Array.from(synced);
	const after = Array.from(value);
	let common = 0;
	while (common < before.length && common < after.length && before[common] === after[common]) {
		common += 1;
	}
	return { deleteCount: before.length - common, insert: after.slice(common).join("") };
}

// The longest common start of two texts, by code point.
export function commonPrefix(left: string, right: string): string {
	const a = Array.from(left);
	const b = Array.from(right);
	let common = 0;
	while (common < a.length && common < b.length && a[common] === b[common]) {
		common += 1;
	}
	return a.slice(0, common).join("");
}

// A line break the IME inserted is Enter for the TUI, as xterm sends it.
export function encodeTextareaEdit({ deleteCount, insert }: TextareaEditDiff): string {
	return DEL.repeat(deleteCount) + insert.replace(/\r?\n/g, ENTER);
}

export interface TerminalImeInputOptions {
	// Read per event: only touch devices hand their edits to us.
	isEnabled: () => boolean;
	// False while the terminal blocks input: the edit is dropped, not queued.
	canSend: () => boolean;
	send: (data: string) => void;
}

export interface TerminalImeInput {
	// Sends what has been dictated so far, then Enter, and leaves the textarea
	// and its focus as they are, so the keyboard keeps listening. False when the
	// terminal blocks input.
	submit: () => boolean;
	// The same for any key's sequence (the key bar's arrows, Tab, Esc, Space).
	sendKey: (data: string) => boolean;
	dispose: () => void;
}

function isPlainEnter(event: KeyboardEvent): boolean {
	return (
		(event.key === "Enter" || event.keyCode === ENTER_KEY_CODE) &&
		!event.shiftKey &&
		!event.ctrlKey &&
		!event.altKey &&
		!event.metaKey
	);
}

export function attachTerminalImeInput(
	host: HTMLElement,
	textarea: HTMLTextAreaElement,
	{ isEnabled, canSend, send }: TerminalImeInputOptions,
): TerminalImeInput {
	// The textarea text the PTY already has (or gets from xterm's composition send).
	let synced = textarea.value;
	// The textarea text that was submitted with Enter, always a prefix of `synced`.
	// The PTY's current line is what follows it, and only that line is diffed.
	let submitted = "";
	// Keys asked for while xterm still owes the PTY a composition's text, in order.
	let pendingKeys: string[] = [];
	let hasPendingEdit = false;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let isComposing = false;
	// xterm sends a finished composition from a 0 ms timer after compositionend.
	let isXtermCompositionSendPending = false;
	// A real key is down: xterm handles its edit, as on desktop.
	let isKeyHeld = false;

	const clearFlushTimer = () => {
		if (flushTimer !== null) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	};

	const flush = () => {
		clearFlushTimer();
		if (!hasPendingEdit) {
			return;
		}
		hasPendingEdit = false;
		const value = textarea.value;
		// What the keyboard changed of the submitted text is gone from the PTY's reach.
		const diff = diffTextareaEdit(synced.slice(submitted.length), value.slice(commonPrefix(submitted, value).length));
		synced = value;
		submitted = commonPrefix(submitted, value);
		if (!canSend() || (diff.deleteCount === 0 && diff.insert.length === 0)) {
			return;
		}
		send(encodeTextareaEdit(diff));
		// A line break the IME typed submitted everything before it.
		const lastBreak = synced.lastIndexOf("\n");
		if (diff.insert.includes("\n") && lastBreak >= 0) {
			submitted = synced.slice(0, lastBreak + 1);
		}
	};

	// Everything the textarea holds is on the PTY now (or was dropped while input was blocked).
	const sendFinal = (data: string) => {
		submitted = synced;
		send(data);
	};

	const sendKey = (data: string): boolean => {
		if (!canSend()) {
			return false;
		}
		if (isComposing || isXtermCompositionSendPending) {
			// The key goes out right after xterm has sent the composition's text.
			pendingKeys.push(data);
			return true;
		}
		flush();
		sendFinal(data);
		return true;
	};

	const submit = (): boolean => sendKey(ENTER);

	// xterm emptied or changed the textarea itself (Enter in a composition, blur,
	// Ctrl+C): what it holds now is the baseline, and only what is left of the
	// submitted text stays submitted.
	const resync = () => {
		synced = textarea.value;
		submitted = commonPrefix(submitted, synced);
	};

	const scheduleFlush = () => {
		clearFlushTimer();
		const delay = textarea.value.startsWith(synced) ? 0 : IME_REWRITE_SETTLE_MS;
		flushTimer = setTimeout(flush, delay);
	};

	const isOurs = (event: Event) => event.target === textarea && isEnabled();

	const onKeyDown = (event: KeyboardEvent) => {
		if (!isOurs(event)) {
			return;
		}
		if (event.keyCode === IME_KEY_CODE) {
			// xterm would diff the textarea itself after this keydown and send that too.
			event.stopPropagation();
			return;
		}
		if (isPlainEnter(event) && !isComposing && !isXtermCompositionSendPending) {
			// Not xterm's Enter, which would empty the textarea under the keyboard.
			event.preventDefault();
			event.stopPropagation();
			submit();
			return;
		}
		// Before xterm handles the key (and Enter clears the textarea), the PTY gets the text.
		flush();
		isKeyHeld = true;
	};
	const onKeyUp = (event: KeyboardEvent) => {
		if (event.target === textarea) {
			isKeyHeld = false;
		}
	};
	const onCompositionStart = (event: CompositionEvent) => {
		if (!isOurs(event)) {
			return;
		}
		flush();
		isComposing = true;
	};
	const onCompositionEnd = (event: CompositionEvent) => {
		if (!isOurs(event)) {
			return;
		}
		isComposing = false;
		isXtermCompositionSendPending = true;
		// This listener runs before xterm's, so the inner timer fires after xterm's send.
		setTimeout(() => {
			setTimeout(() => {
				isXtermCompositionSendPending = false;
				// xterm sent everything from the composition's start to the end of the textarea.
				synced = textarea.value;
				if (pendingKeys.length > 0 && !isComposing) {
					const keys = pendingKeys.join("");
					pendingKeys = [];
					if (canSend()) {
						sendFinal(keys);
					}
				}
			}, 0);
		}, 0);
	};
	const onBeforeInput = (event: Event) => {
		if (!isOurs(event)) {
			return;
		}
		// xterm clears the textarea on Enter and blur: whatever is in it is on the PTY.
		if (!hasPendingEdit && !isComposing && !isXtermCompositionSendPending) {
			resync();
		}
	};
	const onInput = (event: Event) => {
		if (!isOurs(event) || isKeyHeld || isComposing || isXtermCompositionSendPending) {
			return;
		}
		if (event instanceof InputEvent && (event.isComposing || event.inputType === "insertCompositionText")) {
			return;
		}
		event.stopPropagation();
		hasPendingEdit = true;
		scheduleFlush();
	};
	const onBlur = (event: FocusEvent) => {
		if (event.target === textarea) {
			flush();
			isKeyHeld = false;
		}
	};

	// Capture on the host runs before xterm's own listeners on the textarea.
	host.addEventListener("keydown", onKeyDown, true);
	host.addEventListener("keyup", onKeyUp, true);
	host.addEventListener("compositionstart", onCompositionStart, true);
	host.addEventListener("compositionend", onCompositionEnd, true);
	host.addEventListener("beforeinput", onBeforeInput, true);
	host.addEventListener("input", onInput, true);
	host.addEventListener("blur", onBlur, true);
	const dispose = () => {
		clearFlushTimer();
		host.removeEventListener("keydown", onKeyDown, true);
		host.removeEventListener("keyup", onKeyUp, true);
		host.removeEventListener("compositionstart", onCompositionStart, true);
		host.removeEventListener("compositionend", onCompositionEnd, true);
		host.removeEventListener("beforeinput", onBeforeInput, true);
		host.removeEventListener("input", onInput, true);
		host.removeEventListener("blur", onBlur, true);
	};
	return { submit, sendKey, dispose };
}
