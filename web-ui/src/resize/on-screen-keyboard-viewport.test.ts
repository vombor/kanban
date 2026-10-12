import { afterEach, describe, expect, it } from "vitest";

import {
	applyKeyboardViewportFrame,
	computeKeyboardViewportFrame,
	isKeyboardViewportOffsetOnlyChange,
	isSameKeyboardViewportFrame,
	KEYBOARD_BOTTOM_INSET_VAR,
	KEYBOARD_OPEN_ATTRIBUTE,
	KEYBOARD_VISIBLE_HEIGHT_VAR,
	KEYBOARD_VISIBLE_TOP_VAR,
	type ViewportMetrics,
} from "@/resize/on-screen-keyboard-viewport";

// A Pixel 7 in Chrome: 839 px of layout viewport.
function metrics(overrides: Partial<ViewportMetrics>): ViewportMetrics {
	return { layoutHeight: 839, visualHeight: 839, visualOffsetTop: 0, visualScale: 1, ...overrides };
}

describe("computeKeyboardViewportFrame", () => {
	it("is null while no keyboard is open", () => {
		expect(computeKeyboardViewportFrame(metrics({}))).toBeNull();
	});

	it("is null without the VisualViewport API", () => {
		expect(computeKeyboardViewportFrame(null)).toBeNull();
	});

	it("ignores browser chrome hiding a little of the layout", () => {
		expect(computeKeyboardViewportFrame(metrics({ visualHeight: 783 }))).toBeNull();
	});

	it("gives the part above an open keyboard", () => {
		expect(computeKeyboardViewportFrame(metrics({ visualHeight: 499.4 }))).toEqual({
			top: 0,
			height: 499,
			bottomInset: 340,
		});
	});

	it("follows the visible part when the browser scrolled it down", () => {
		expect(computeKeyboardViewportFrame(metrics({ visualHeight: 499, visualOffsetTop: 120.6 }))).toEqual({
			top: 121,
			height: 499,
			bottomInset: 219,
		});
	});

	it("keeps the frame inside the layout when the offset overshoots", () => {
		expect(computeKeyboardViewportFrame(metrics({ visualHeight: 499, visualOffsetTop: 600 }))).toEqual({
			top: 340,
			height: 499,
			bottomInset: 0,
		});
		expect(computeKeyboardViewportFrame(metrics({ visualHeight: 499, visualOffsetTop: -40 }))?.top).toBe(0);
	});

	it("is null while the page is pinch-zoomed", () => {
		expect(computeKeyboardViewportFrame(metrics({ visualHeight: 419, visualScale: 2 }))).toBeNull();
	});
});

describe("frame comparisons", () => {
	const open = { top: 0, height: 499, bottomInset: 340 };

	it("compares frames by value", () => {
		expect(isSameKeyboardViewportFrame(open, { ...open })).toBe(true);
		expect(isSameKeyboardViewportFrame(open, { ...open, top: 10, bottomInset: 330 })).toBe(false);
		expect(isSameKeyboardViewportFrame(null, null)).toBe(true);
		expect(isSameKeyboardViewportFrame(open, null)).toBe(false);
	});

	it("tells an offset-only move from a size change", () => {
		expect(isKeyboardViewportOffsetOnlyChange(open, { top: 80, height: 499, bottomInset: 260 })).toBe(true);
		expect(isKeyboardViewportOffsetOnlyChange(open, { top: 0, height: 450, bottomInset: 389 })).toBe(false);
		expect(isKeyboardViewportOffsetOnlyChange(null, open)).toBe(false);
		expect(isKeyboardViewportOffsetOnlyChange(open, null)).toBe(false);
	});
});

describe("applyKeyboardViewportFrame", () => {
	afterEach(() => {
		applyKeyboardViewportFrame(document.documentElement, null);
	});

	it("sets the variables while open and removes them when closed", () => {
		const root = document.documentElement;
		applyKeyboardViewportFrame(root, { top: 121, height: 499, bottomInset: 219 });
		expect(root.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(true);
		expect(root.style.getPropertyValue(KEYBOARD_VISIBLE_TOP_VAR)).toBe("121px");
		expect(root.style.getPropertyValue(KEYBOARD_VISIBLE_HEIGHT_VAR)).toBe("499px");
		expect(root.style.getPropertyValue(KEYBOARD_BOTTOM_INSET_VAR)).toBe("219px");

		applyKeyboardViewportFrame(root, null);
		expect(root.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE)).toBe(false);
		expect(root.style.getPropertyValue(KEYBOARD_VISIBLE_TOP_VAR)).toBe("");
		expect(root.style.getPropertyValue(KEYBOARD_VISIBLE_HEIGHT_VAR)).toBe("");
		expect(root.style.getPropertyValue(KEYBOARD_BOTTOM_INSET_VAR)).toBe("");
	});
});
