import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	attachTerminalImeInput,
	diffTextareaEdit,
	encodeTextareaEdit,
	IME_REWRITE_SETTLE_MS,
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
	let detach: () => void;

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
		detach = attachTerminalImeInput(host, textarea, {
			isEnabled: () => enabled,
			canSend: () => accepting,
			send: (data) => {
				sent.push(data);
			},
		});
	});

	afterEach(() => {
		detach();
		host.remove();
		vi.useRealTimers();
	});

	// What the browser does for an IME edit: beforeinput on the old value, the edit, input.
	function imeEdit(value: string, inputType: string, isComposing = false) {
		textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, isComposing }));
		textarea.value = value;
		textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, isComposing }));
	}

	function key(type: "keydown" | "keyup", keyName: string, keyCode: number) {
		textarea.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: keyName, keyCode }));
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
		key("keydown", "Enter", 13);
		expect(sent).toEqual(["ab"]);
		expect(xtermSaw).toEqual(["keydown:Enter"]);
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
		key("keydown", "Enter", 13);
		textarea.value = "";
		key("keyup", "Enter", 13);
		imeEdit("yes", "insertText");
		vi.runAllTimers();
		expect(sent).toEqual(["hi", "yes"]);
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
