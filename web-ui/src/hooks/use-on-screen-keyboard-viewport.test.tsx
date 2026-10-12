import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEYBOARD_SETTLE_MS, useOnScreenKeyboardViewport } from "@/hooks/use-on-screen-keyboard-viewport";
import {
	KEYBOARD_OPEN_ATTRIBUTE,
	KEYBOARD_VISIBLE_HEIGHT_VAR,
	KEYBOARD_VISIBLE_TOP_VAR,
} from "@/resize/on-screen-keyboard-viewport";

// A visual viewport the test moves, like a keyboard does on a phone.
class FakeVisualViewport extends EventTarget {
	height = window.innerHeight;
	offsetTop = 0;
	scale = 1;

	move(height: number, offsetTop = 0): void {
		this.height = height;
		this.offsetTop = offsetTop;
		this.dispatchEvent(new Event(offsetTop === 0 ? "resize" : "scroll"));
	}
}

function HookHarness({ enabled }: { enabled: boolean }): null {
	useOnScreenKeyboardViewport(enabled);
	return null;
}

function visibleHeight(): string {
	return document.documentElement.style.getPropertyValue(KEYBOARD_VISIBLE_HEIGHT_VAR);
}

describe("useOnScreenKeyboardViewport", () => {
	let container: HTMLDivElement;
	let root: Root;
	let viewport: FakeVisualViewport;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		viewport = new FakeVisualViewport();
		Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		Reflect.deleteProperty(window, "visualViewport");
		vi.useRealTimers();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("applies the settled size once the keyboard stops animating, and restores it on close", () => {
		act(() => {
			root.render(<HookHarness enabled />);
		});
		const keyboardHeight = 340;
		const openHeight = window.innerHeight - keyboardHeight;

		act(() => {
			for (let step = 1; step <= 10; step += 1) {
				viewport.move(window.innerHeight - (keyboardHeight * step) / 10);
				vi.advanceTimersByTime(16);
			}
		});
		// Nothing while it animates, so nothing resizes on every frame.
		expect(document.documentElement.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(false);
		act(() => {
			vi.advanceTimersByTime(KEYBOARD_SETTLE_MS);
		});
		expect(document.documentElement.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(true);
		expect(visibleHeight()).toBe(`${openHeight}px`);

		act(() => {
			viewport.move(window.innerHeight);
			vi.advanceTimersByTime(KEYBOARD_SETTLE_MS);
		});
		expect(document.documentElement.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(false);
		expect(visibleHeight()).toBe("");
	});

	it("follows an offset-only scroll at once", () => {
		act(() => {
			root.render(<HookHarness enabled />);
		});
		act(() => {
			viewport.move(window.innerHeight - 340);
			vi.advanceTimersByTime(KEYBOARD_SETTLE_MS);
		});
		act(() => {
			viewport.move(window.innerHeight - 340, 120);
		});
		expect(document.documentElement.style.getPropertyValue(KEYBOARD_VISIBLE_TOP_VAR)).toBe("120px");
	});

	it("does nothing when disabled and clears the frame when it becomes disabled", () => {
		act(() => {
			root.render(<HookHarness enabled={false} />);
		});
		act(() => {
			viewport.move(window.innerHeight - 340);
			vi.advanceTimersByTime(KEYBOARD_SETTLE_MS);
		});
		expect(document.documentElement.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(false);

		// Enabled with the keyboard already open: the hook reads the viewport itself.
		act(() => {
			root.render(<HookHarness enabled />);
		});
		act(() => {
			vi.advanceTimersByTime(KEYBOARD_SETTLE_MS);
		});
		expect(document.documentElement.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(true);

		act(() => {
			root.render(<HookHarness enabled={false} />);
		});
		expect(document.documentElement.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(false);
	});
});
