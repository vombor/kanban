import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalTouchControls } from "@/components/detail-panels/terminal-touch-controls";
import { PRESS_REPEAT_DELAY_MS, PRESS_REPEAT_INTERVAL_MS } from "@/hooks/use-press-repeat";
import type { TerminalTouchKey } from "@/terminal/terminal-touch-keys";

// jsdom has no PointerEvent; React reads `button` from any MouseEvent.
function pointer(type: "pointerdown" | "pointerup", target: Element): MouseEvent {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
	target.dispatchEvent(event);
	return event;
}

describe("TerminalTouchControls", () => {
	let container: HTMLDivElement;
	let root: Root;
	let textarea: HTMLTextAreaElement;
	let keys: TerminalTouchKey[];
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

	function render(showKeys = true) {
		act(() => {
			root.render(
				<TerminalTouchControls
					showJumpToBottom={false}
					showKeys={showKeys}
					onJumpToBottom={() => {}}
					onKey={(key) => keys.push(key)}
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

	it("shows Enter and a closed key pad by default", () => {
		render();
		expect(button("Send Enter")).toBeTruthy();
		expect(button("Show terminal keys").getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector('[role="toolbar"]')).toBeNull();
	});

	it("shows nothing while the terminal takes no input", () => {
		render(false);
		expect(container.innerHTML).toBe("");
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
			["Send Space", "space"],
			["Send Enter", "enter"],
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
		expect(container.querySelector('[role="toolbar"]')).toBeNull();
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

	it("does not repeat Tab, Esc or Space", () => {
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
});
