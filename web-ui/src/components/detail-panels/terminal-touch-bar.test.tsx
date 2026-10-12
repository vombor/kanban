import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalTouchBar } from "@/components/detail-panels/terminal-touch-bar";
import { PRESS_REPEAT_DELAY_MS, PRESS_REPEAT_INTERVAL_MS } from "@/hooks/use-press-repeat";
import { PASTE_MESSAGE_MS, PASTE_NOT_SENT_MESSAGE } from "@/hooks/use-touch-paste";
import { CLIPBOARD_TEXT_MESSAGES } from "@/terminal/clipboard-text";
import type { TerminalTouchKey } from "@/terminal/terminal-touch-keys";

// jsdom has no PointerEvent; React reads `button` from any MouseEvent.
function pointer(type: "pointerdown" | "pointerup", target: Element): MouseEvent {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
	target.dispatchEvent(event);
	return event;
}

describe("TerminalTouchBar", () => {
	let container: HTMLDivElement;
	let root: Root;
	let textarea: HTMLTextAreaElement;
	let keys: TerminalTouchKey[];
	let jumps: number;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		// Stands in for xterm's textarea, which holds the keyboard's focus.
		textarea = document.createElement("textarea");
		textarea.value = "dictated";
		document.body.appendChild(textarea);
		textarea.focus();
		root = createRoot(container);
		keys = [];
		jumps = 0;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		textarea.remove();
		vi.useRealTimers();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function render(showJumpToBottom = false) {
		act(() => {
			root.render(
				<TerminalTouchBar
					showJumpToBottom={showJumpToBottom}
					onJumpToBottom={() => {
						jumps += 1;
					}}
					onKey={(key) => keys.push(key)}
					onPaste={() => true}
				/>,
			);
		});
	}

	function button(label: string): HTMLButtonElement {
		const found = container.querySelector(`button[aria-label="${label}"]`);
		if (!(found instanceof HTMLButtonElement)) {
			throw new Error(`No button "${label}".`);
		}
		return found;
	}

	// A tap: pointer down, mouse down, pointer up, click (detail 1, as a real tap).
	function tap(target: HTMLButtonElement): { pointerDown: MouseEvent; mouseDown: MouseEvent } {
		let pointerDown = new MouseEvent("pointerdown");
		let mouseDown = new MouseEvent("mousedown");
		act(() => {
			pointerDown = pointer("pointerdown", target);
			mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
			target.dispatchEvent(mouseDown);
			pointer("pointerup", target);
			target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
		});
		return { pointerDown, mouseDown };
	}

	it("shows the key pad toggle and Enter at the right of one row with the pad closed, jump to bottom left of them", () => {
		render(true);
		expect(button("Show terminal keys").getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector('[role="toolbar"][aria-label="Terminal keys"]')).toBeNull();
		const row = container.querySelector('[role="toolbar"][aria-label="Terminal controls"]');
		const labels = Array.from(row?.querySelectorAll("button") ?? []).map((found) => found.getAttribute("aria-label"));
		expect(labels).toEqual(["Jump to bottom", "Show terminal keys", "Send Enter"]);
		// Enter is the row's last child whether jump to bottom is there or not.
		expect(row?.lastElementChild?.getAttribute("aria-label")).toBe("Send Enter");
	});

	it("opens the pad's keys right above the control row", () => {
		render();
		tap(button("Show terminal keys"));
		const pad = container.querySelector('[role="toolbar"][aria-label="Terminal keys"]');
		const row = container.querySelector('[role="toolbar"][aria-label="Terminal controls"]');
		expect(pad?.nextElementSibling).toBe(row);
		expect(row?.parentElement?.lastElementChild).toBe(row);
	});

	it("sends Enter to the terminal without taking focus from the textarea", () => {
		render();
		expect(container.querySelector('button[aria-label="Jump to bottom"]')).toBeNull();
		const { pointerDown, mouseDown } = tap(button("Send Enter"));
		expect(pointerDown.defaultPrevented).toBe(true);
		expect(mouseDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(textarea);
		expect(textarea.value).toBe("dictated");
		expect(keys).toEqual(["enter"]);
	});

	it("jumps to bottom without taking focus from the textarea", () => {
		render(true);
		const { pointerDown, mouseDown } = tap(button("Jump to bottom"));
		expect(pointerDown.defaultPrevented).toBe(true);
		expect(mouseDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(textarea);
		expect(jumps).toBe(1);
	});

	it("sends each key once per tap and never takes focus from the textarea", () => {
		render();
		tap(button("Show terminal keys"));
		const labels: Array<[string, TerminalTouchKey]> = [
			["Send Up", "up"],
			["Send Down", "down"],
			["Send Left", "left"],
			["Send Right", "right"],
			["Send Tab", "tab"],
			["Send Shift+Tab", "shiftTab"],
			["Send Esc", "escape"],
		];
		for (const label of [...labels.map(([buttonLabel]) => buttonLabel), "Hide terminal keys"]) {
			const { pointerDown, mouseDown } = tap(button(label));
			// The browser's default for these moves focus to the button and closes the keyboard.
			expect(pointerDown.defaultPrevented, label).toBe(true);
			expect(mouseDown.defaultPrevented, label).toBe(true);
			expect(document.activeElement).toBe(textarea);
		}
		expect(keys).toEqual(labels.map(([, key]) => key));
		expect(textarea.value).toBe("dictated");
		// The last tap closed the pad.
		expect(container.querySelector('[role="toolbar"][aria-label="Terminal keys"]')).toBeNull();
	});

	it("remembers that the pad is open", () => {
		render();
		tap(button("Show terminal keys"));
		act(() => {
			root.unmount();
		});
		root = createRoot(container);
		render();
		expect(button("Hide terminal keys").getAttribute("aria-expanded")).toBe("true");
	});

	it("repeats a held arrow and stops on release", () => {
		vi.useFakeTimers();
		render();
		tap(button("Show terminal keys"));
		const down = button("Send Down");
		act(() => {
			pointer("pointerdown", down);
		});
		expect(keys).toEqual(["down"]);
		act(() => {
			vi.advanceTimersByTime(PRESS_REPEAT_DELAY_MS + PRESS_REPEAT_INTERVAL_MS * 3);
		});
		expect(keys).toEqual(["down", "down", "down", "down"]);
		act(() => {
			pointer("pointerup", down);
			vi.advanceTimersByTime(PRESS_REPEAT_INTERVAL_MS * 5);
		});
		expect(keys).toHaveLength(4);
	});

	it("does not repeat Tab or Esc", () => {
		vi.useFakeTimers();
		render();
		tap(button("Show terminal keys"));
		const tab = button("Send Tab");
		act(() => {
			pointer("pointerdown", tab);
			vi.advanceTimersByTime(PRESS_REPEAT_DELAY_MS * 3);
			pointer("pointerup", tab);
			tab.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		});
		expect(keys).toEqual(["tab"]);
	});

	describe("Paste", () => {
		let readText: ReturnType<typeof vi.fn>;
		let pasted: string[];
		let pasteAccepted: boolean;
		let originalClipboard: PropertyDescriptor | undefined;
		let originalSecure: PropertyDescriptor | undefined;

		function setSecureContext(secure: boolean) {
			Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
		}

		beforeEach(() => {
			readText = vi.fn(async () => "copied log\nline two");
			pasted = [];
			pasteAccepted = true;
			originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
			originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
			setSecureContext(true);
		});

		afterEach(() => {
			if (originalClipboard) {
				Object.defineProperty(navigator, "clipboard", originalClipboard);
			} else {
				Reflect.deleteProperty(navigator, "clipboard");
			}
			if (originalSecure) {
				Object.defineProperty(window, "isSecureContext", originalSecure);
			} else {
				Reflect.deleteProperty(window, "isSecureContext");
			}
		});

		function renderWithPaste() {
			act(() => {
				root.render(
					<TerminalTouchBar
						showJumpToBottom={false}
						onJumpToBottom={() => {}}
						onKey={(key) => keys.push(key)}
						onPaste={(text) => {
							pasted.push(text);
							return pasteAccepted;
						}}
					/>,
				);
			});
			tap(button("Show terminal keys"));
		}

		async function tapPaste() {
			const events = tap(button("Paste"));
			// The clipboard read resolves after the click.
			await act(async () => {
				await Promise.resolve();
			});
			return events;
		}

		function message(): string | null {
			return container.querySelector('[role="status"]')?.textContent ?? null;
		}

		it("sits in Space's place, between Tab and the arrows", () => {
			renderWithPaste();
			const pad = container.querySelector('[role="toolbar"][aria-label="Terminal keys"]');
			const labels = Array.from(pad?.querySelectorAll("button") ?? []).map((found) =>
				found.getAttribute("aria-label"),
			);
			expect(labels).toEqual([
				"Send Esc",
				"Send Shift+Tab",
				"Send Tab",
				"Paste",
				"Send Left",
				"Send Up",
				"Send Down",
				"Send Right",
			]);
			expect(container.querySelector('button[aria-label="Send Space"]')).toBeNull();
		});

		it("reads the clipboard in the tap and hands its text to the terminal's paste, keeping focus", async () => {
			renderWithPaste();
			const { pointerDown, mouseDown } = await tapPaste();
			expect(pointerDown.defaultPrevented).toBe(true);
			expect(mouseDown.defaultPrevented).toBe(true);
			expect(readText).toHaveBeenCalledTimes(1);
			expect(pasted).toEqual(["copied log\nline two"]);
			// Not as typed keys.
			expect(keys).toEqual([]);
			expect(message()).toBeNull();
			expect(document.activeElement).toBe(textarea);
			expect(textarea.value).toBe("dictated");
		});

		it("says so when the clipboard read is refused, and the message goes away", async () => {
			vi.useFakeTimers();
			readText.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
			renderWithPaste();
			await tapPaste();
			expect(pasted).toEqual([]);
			expect(message()).toBe(CLIPBOARD_TEXT_MESSAGES.refused);
			expect(document.activeElement).toBe(textarea);
			act(() => {
				vi.advanceTimersByTime(PASTE_MESSAGE_MS);
			});
			expect(message()).toBeNull();
		});

		it("says so when the clipboard holds no text", async () => {
			readText.mockResolvedValue("");
			renderWithPaste();
			await tapPaste();
			expect(pasted).toEqual([]);
			expect(message()).toBe(CLIPBOARD_TEXT_MESSAGES.empty);
		});

		it("says so outside a secure context, without asking for the clipboard", async () => {
			setSecureContext(false);
			renderWithPaste();
			await tapPaste();
			expect(readText).not.toHaveBeenCalled();
			expect(message()).toBe(CLIPBOARD_TEXT_MESSAGES.insecure);
		});

		it("says so when the browser has no clipboard read", async () => {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
			renderWithPaste();
			await tapPaste();
			expect(message()).toBe(CLIPBOARD_TEXT_MESSAGES.unsupported);
		});

		it("says so when the terminal takes no input", async () => {
			pasteAccepted = false;
			renderWithPaste();
			await tapPaste();
			expect(pasted).toEqual(["copied log\nline two"]);
			expect(message()).toBe(PASTE_NOT_SENT_MESSAGE);
		});
	});
});
