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

const DEL = "\x7f";
const IME_KEY_CODE = 229;
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

// A line break the IME inserted is Enter for the TUI, as xterm sends it.
export function encodeTextareaEdit({ deleteCount, insert }: TextareaEditDiff): string {
	return DEL.repeat(deleteCount) + insert.replace(/\r?\n/g, "\r");
}

export interface TerminalImeInputOptions {
	// Read per event: only touch devices hand their edits to us.
	isEnabled: () => boolean;
	// False while the terminal blocks input: the edit is dropped, not queued.
	canSend: () => boolean;
	send: (data: string) => void;
}

export function attachTerminalImeInput(
	host: HTMLElement,
	textarea: HTMLTextAreaElement,
	{ isEnabled, canSend, send }: TerminalImeInputOptions,
): () => void {
	// The textarea text the PTY already has (or gets from xterm's composition send).
	let synced = textarea.value;
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
		const diff = diffTextareaEdit(synced, textarea.value);
		synced = textarea.value;
		if (!canSend() || (diff.deleteCount === 0 && diff.insert.length === 0)) {
			return;
		}
		send(encodeTextareaEdit(diff));
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
			}, 0);
		}, 0);
	};
	const onBeforeInput = (event: Event) => {
		if (!isOurs(event)) {
			return;
		}
		// xterm clears the textarea on Enter and blur: whatever is in it is on the PTY.
		if (!hasPendingEdit && !isComposing && !isXtermCompositionSendPending) {
			synced = textarea.value;
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
	return () => {
		clearFlushTimer();
		host.removeEventListener("keydown", onKeyDown, true);
		host.removeEventListener("keyup", onKeyUp, true);
		host.removeEventListener("compositionstart", onCompositionStart, true);
		host.removeEventListener("compositionend", onCompositionEnd, true);
		host.removeEventListener("beforeinput", onBeforeInput, true);
		host.removeEventListener("input", onInput, true);
		host.removeEventListener("blur", onBlur, true);
	};
}
