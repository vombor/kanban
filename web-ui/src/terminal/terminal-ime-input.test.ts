import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	attachTerminalImeInput,
	commonPrefix,
	diffTextareaEdit,
	encodeTextareaEdit,
	IME_REWRITE_SETTLE_MS,
	type TerminalImeInput,
} from "@/terminal/terminal-ime-input";

describe("diffTextareaEdit", () => {
	it("sends only the new end of a hypothesis that grows", () => {
		expect(diffTextareaEdit("let", "let me")).toEqual({ deleteCount: 0, insert: " me" });
	});

	it("takes back what changed before sending the rest", () => {
		expect(diffTextareaEdit("see", "sea shells")).toEqual({ deleteCount: 1, insert: "a shells" });
		expect(diffTextareaEdit("let me", "")).toEqual({ deleteCount: 6, insert: "" });
	});

	it("counts an emoji as one character", () => {
		expect(diffTextareaEdit("ok 👍", "ok 👌")).toEqual({ deleteCount: 1, insert: "👌" });
	});

	it("finds the common start by code point", () => {
		expect(commonPrefix("let me kn", "let me know")).toBe("let me kn");
		expect(commonPrefix("ok 👍", "ok 👌")).toBe("ok ");
		expect(commonPrefix("done", "")).toBe("");
	});

	it("encodes Backspaces as DEL and a line break as Enter", () => {
		expect(encodeTextareaEdit({ deleteCount: 2, insert: "a\nb" })).toBe("\x7f\x7fa\rb");
	});
});

describe("attachTerminalImeInput", () => {
	let host: HTMLDivElement;
	let textarea: HTMLTextAreaElement;
	let sent: string[];
	// What xterm's own listeners on the textarea get to see.
	let xtermSaw: string[];
	let enabled: boolean;
	let accepting: boolean;
	let ime: TerminalImeInput;

	beforeEach(() => {
		vi.useFakeTimers();
		host = document.createElement("div");
		textarea = document.createElement("textarea");
		host.appendChild(textarea);
		document.body.appendChild(host);
		sent = [];
		xtermSaw = [];
		enabled = true;
		accepting = true;
		for (const type of ["input", "keydown", "compositionend"]) {
			textarea.addEventListener(type, (event) => {
				const detail =
					event instanceof InputEvent ? event.inputType : event instanceof KeyboardEvent ? event.key : "";
				xtermSaw.push(`${type}:${detail}`);
			});
		}
		ime = attachTerminalImeInput(host, textarea, {
			isEnabled: () => enabled,
			canSend: () => accepting,
			send: (data) => {
				sent.push(data);
			},
		});
	});

	afterEach(() => {
		ime.dispose();
		host.remove();
		vi.useRealTimers();
	});

	// What the browser does for an IME edit: beforeinput on the old value, the edit, input.
	function imeEdit(value: string, inputType: string, isComposing = false) {
		textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, isComposing }));
		textarea.value = value;
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, isComposing }));
	}

	function key(type: "keydown" | "keyup", keyName: string, keyCode: number, init: KeyboardEventInit = {}) {
		const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, key: keyName, keyCode, ...init });
		textarea.dispatchEvent(event);
		return event;
	}

	it("sends dictation that deletes and recommits its interim results once", () => {
		imeEdit("l", "insertText");
		for (const partial of ["let", "let me", "let me know", "let me know when"]) {
			imeEdit("", "deleteContentBackward");
			imeEdit(partial, "insertText");
		}
		vi.runAllTimers();
		expect(sent.join("")).toBe("let me know when");
		// xterm never saw those edits, so it sent nothing of its own.
		expect(xtermSaw).toEqual([]);
	});

	it("waits for the text that replaces what the IME took back", () => {
		imeEdit("see", "insertText");
		vi.runAllTimers();
		imeEdit("", "deleteContentBackward");
		vi.advanceTimersByTime(IME_REWRITE_SETTLE_MS - 1);
		expect(sent).toEqual(["see"]);
		imeEdit("sea shells", "insertText");
		vi.advanceTimersByTime(IME_REWRITE_SETTLE_MS);
		expect(sent).toEqual(["see", "\x7fa shells"]);
	});

	it("sends a pending edit before the key that follows it", () => {
		imeEdit("abc", "deleteContentBackward");
		imeEdit("ab", "deleteContentBackward");
		key("keydown", "Tab", 9);
		expect(sent).toEqual(["ab"]);
		expect(xtermSaw).toEqual(["keydown:Tab"]);
	});

	it("keeps IME keydowns from xterm, which would send the textarea diff a second time", () => {
		key("keydown", "Unidentified", 229);
		imeEdit("a", "insertText");
		key("keyup", "Unidentified", 229);
		vi.runAllTimers();
		expect(sent).toEqual(["a"]);
		expect(xtermSaw).toEqual([]);
	});

	it("leaves compositions to xterm and counts what xterm sent", () => {
		textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		imeEdit("hel", "insertCompositionText", true);
		imeEdit("hello", "insertCompositionText", true);
		textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hello" }));
		vi.runAllTimers();
		expect(sent).toEqual([]);
		expect(xtermSaw).toEqual(["input:insertCompositionText", "input:insertCompositionText", "compositionend:"]);
		// The next edit sends only itself.
		imeEdit("hello ", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual([" "]);
	});

	it("starts over after xterm clears its textarea", () => {
		imeEdit("hi", "insertText");
		vi.runAllTimers();
		key("keydown", "c", 67, { ctrlKey: true });
		textarea.value = "";
		key("keyup", "c", 67, { ctrlKey: true });
		imeEdit("yes", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["hi", "yes"]);
	});

	it("sends Enter itself and leaves the textarea to the keyboard", () => {
		imeEdit("let me", "insertText");
		const enter = key("keydown", "Enter", 13);
		expect(sent).toEqual(["let me", "\r"]);
		// xterm never saw the Enter, so it didn't empty the textarea under the keyboard.
		expect(xtermSaw).toEqual([]);
		expect(enter.defaultPrevented).toBe(true);
		expect(textarea.value).toBe("let me");
	});

	it("keeps dictating after a submit without sending the submitted text again", () => {
		imeEdit("let me", "insertText");
		expect(ime.submit()).toBe(true);
		imeEdit("let me know", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["let me", "\r", " know"]);
	});

	it("never takes back submitted text when the keyboard rewrites its hypothesis", () => {
		// Sent mid-hypothesis: the keyboard then replaces "let me kn" with its final "let me know".
		imeEdit("let me kn", "insertText");
		ime.submit();
		imeEdit("", "deleteContentBackward");
		imeEdit("let me know", "insertText");
		vi.runAllTimers();
		// The keyboard replaces all of it: the current line ("ow") becomes the new text.
		imeEdit("", "deleteContentBackward");
		imeEdit("see", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["let me kn", "\r", "ow", "\x7f\x7fsee"]);
	});

	it("drops what the keyboard deletes of submitted text and sends the next words whole", () => {
		imeEdit("done", "insertText");
		ime.submit();
		imeEdit("", "deleteContentBackward");
		vi.runAllTimers();
		imeEdit("next", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["done", "\r", "next"]);
	});

	it("treats a line break the keyboard typed as a submit", () => {
		imeEdit("one\n", "insertLineBreak");
		vi.runAllTimers();
		imeEdit("", "deleteContentBackward");
		imeEdit("two", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["one\r", "two"]);
	});

	it("submits after xterm has sent a composition that was still open", () => {
		textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		imeEdit("hello", "insertCompositionText", true);
		expect(ime.submit()).toBe(true);
		expect(sent).toEqual([]);
		textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hello" }));
		vi.runAllTimers();
		// xterm sent "hello" itself; Enter follows it.
		expect(sent).toEqual(["\r"]);
		imeEdit("hello there", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["\r", " there"]);
	});

	it("sends pending dictation before a key bar key, and that text is final", () => {
		imeEdit("2", "insertText");
		expect(ime.sendKey("\x1b[B")).toBe(true);
		expect(sent).toEqual(["2", "\x1b[B"]);
		// The keyboard rewrites its hypothesis after the key: the TUI already acted on "2".
		imeEdit("", "deleteContentBackward");
		imeEdit("two", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["2", "\x1b[B", "two"]);
		expect(textarea.value).toBe("two");
		expect(xtermSaw).toEqual([]);
	});

	it("sends key bar keys after xterm has sent a composition that was still open, in order", () => {
		textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		imeEdit("hi", "insertCompositionText", true);
		ime.sendKey(" ");
		ime.sendKey("\t");
		expect(sent).toEqual([]);
		textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hi" }));
		vi.runAllTimers();
		expect(sent).toEqual([" \t"]);
	});

	it("refuses a key bar key while the terminal blocks input", () => {
		accepting = false;
		expect(ime.sendKey("\x1b")).toBe(false);
		expect(sent).toEqual([]);
	});

	it("leaves Enter to xterm inside a composition and Shift+Enter always", () => {
		key("keydown", "Enter", 13, { shiftKey: true });
		textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		key("keydown", "Enter", 13);
		expect(sent).toEqual([]);
		expect(xtermSaw).toEqual(["keydown:Enter", "keydown:Enter"]);
	});

	it("refuses a submit while the terminal blocks input", () => {
		imeEdit("wait", "insertText");
		accepting = false;
		expect(ime.submit()).toBe(false);
		vi.runAllTimers();
		expect(sent).toEqual([]);
	});

	it("leaves the edit of a real key to xterm", () => {
		key("keydown", "é", 0);
		imeEdit("é", "insertText");
		key("keyup", "é", 0);
		vi.runAllTimers();
		expect(sent).toEqual([]);
		expect(xtermSaw).toEqual(["keydown:é", "input:insertText"]);
		imeEdit("é!", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["!"]);
	});

	it("drops edits while the terminal blocks input", () => {
		accepting = false;
		imeEdit("lost", "insertText");
		vi.runAllTimers();
		accepting = true;
		imeEdit("lost!", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["!"]);
	});

	it("does nothing on a desktop pointer", () => {
		enabled = false;
		key("keydown", "Unidentified", 229);
		imeEdit("a", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual([]);
		expect(xtermSaw).toEqual(["keydown:Unidentified", "input:insertText"]);
	});

	it("sends a pending edit when the textarea loses focus", () => {
		imeEdit("abc", "insertText");
		imeEdit("ab", "deleteContentBackward");
		textarea.dispatchEvent(new FocusEvent("blur"));
		expect(sent).toEqual(["ab"]);
	});
});
