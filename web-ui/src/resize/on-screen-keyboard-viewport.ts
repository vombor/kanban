// The part of the page an on-screen keyboard leaves visible, on a phone.
//
// One mechanism for both phone browsers: the VisualViewport API. The viewport
// meta keeps Chrome Android's default `interactive-widget=resizes-visual`
// (stated explicitly in index.html), so there, as on iOS Safari, the keyboard
// shrinks only the visual viewport and the layout keeps its height. Kanban then
// sizes the app to the visible part itself, once the keyboard has settled
// (use-on-screen-keyboard-viewport.ts), so a terminal fits and resizes its PTY
// once per open/close. Not chosen: `resizes-content` (Chrome only) resizes the
// layout, and so every terminal's ResizeObserver, while the keyboard animates;
// the VirtualKeyboard API (`overlaysContent` + `env(keyboard-inset-*)`, Chromium
// only) stops the visual viewport from shrinking and would need a second path
// for iOS, which has neither.
//
// The frame is published as CSS variables on <html> (the app shell in
// globals.css, the mobile bottom pane and sidebar), and only while a keyboard is
// open: closed, they are removed and the layout is exactly the one without this.

export interface ViewportMetrics {
	// The layout viewport (window.innerHeight), which the keyboard doesn't change.
	layoutHeight: number;
	visualHeight: number;
	// How far the browser scrolled the visual viewport down the layout one (iOS
	// does to show the focused field).
	visualOffsetTop: number;
	visualScale: number;
}

export interface KeyboardViewportFrame {
	// The visible part, in layout viewport pixels.
	top: number;
	height: number;
	// What the keyboard covers below it.
	bottomInset: number;
}

// Less than this hidden is browser chrome (Android's URL bar), not a keyboard.
export const KEYBOARD_MIN_COVERED_PX = 120;

// A pinch zoom shrinks the visual viewport too, with no keyboard.
const ZOOMED_SCALE = 1.01;

export const KEYBOARD_VISIBLE_TOP_VAR = "--kb-visible-top";
export const KEYBOARD_VISIBLE_HEIGHT_VAR = "--kb-visible-height";
export const KEYBOARD_BOTTOM_INSET_VAR = "--kb-keyboard-inset";
export const KEYBOARD_OPEN_ATTRIBUTE = "data-kb-keyboard-open";

export function readViewportMetrics(win: Window): ViewportMetrics | null {
	const viewport = win.visualViewport;
	if (!viewport) {
		return null;
	}
	return {
		layoutHeight: win.innerHeight,
		visualHeight: viewport.height,
		visualOffsetTop: viewport.offsetTop,
		visualScale: viewport.scale,
	};
}

export function computeKeyboardViewportFrame(metrics: ViewportMetrics | null): KeyboardViewportFrame | null {
	if (!metrics || metrics.visualScale > ZOOMED_SCALE) {
		return null;
	}
	const layoutHeight = Math.round(metrics.layoutHeight);
	const height = Math.floor(Math.min(metrics.visualHeight, layoutHeight));
	if (height <= 0 || layoutHeight - height < KEYBOARD_MIN_COVERED_PX) {
		return null;
	}
	const top = Math.min(Math.max(0, Math.round(metrics.visualOffsetTop)), layoutHeight - height);
	return { top, height, bottomInset: layoutHeight - height - top };
}

export function isSameKeyboardViewportFrame(
	left: KeyboardViewportFrame | null,
	right: KeyboardViewportFrame | null,
): boolean {
	if (!left || !right) {
		return left === right;
	}
	return left.top === right.top && left.height === right.height && left.bottomInset === right.bottomInset;
}

// Only the offset moved (iOS scrolling the visible part): nothing changes size,
// so it can follow at once.
export function isKeyboardViewportOffsetOnlyChange(
	applied: KeyboardViewportFrame | null,
	next: KeyboardViewportFrame | null,
): boolean {
	return applied !== null && next !== null && applied.height === next.height;
}

export function applyKeyboardViewportFrame(root: HTMLElement, frame: KeyboardViewportFrame | null): void {
	if (!frame) {
		root.removeAttribute(KEYBOARD_OPEN_ATTRIBUTE);
		root.style.removeProperty(KEYBOARD_VISIBLE_TOP_VAR);
		root.style.removeProperty(KEYBOARD_VISIBLE_HEIGHT_VAR);
		root.style.removeProperty(KEYBOARD_BOTTOM_INSET_VAR);
		return;
	}
	root.setAttribute(KEYBOARD_OPEN_ATTRIBUTE, "");
	root.style.setProperty(KEYBOARD_VISIBLE_TOP_VAR, `${frame.top}px`);
	root.style.setProperty(KEYBOARD_VISIBLE_HEIGHT_VAR, `${frame.height}px`);
	root.style.setProperty(KEYBOARD_BOTTOM_INSET_VAR, `${frame.bottomInset}px`);
}
