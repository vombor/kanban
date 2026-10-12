import { expect, type Locator, type Page, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";
import {
	boxOf,
	isTerminalFocused,
	openShellTerminal,
	recordShellResizes,
	settledCount,
	tapToFocus,
} from "./terminal-page";

// The terminal panel stays above the on-screen keyboard (Pixel 7 profile).
//
// Headless Chromium has no on-screen keyboard, and CDP can't shrink only the
// visual viewport: Emulation.setVisibleSize changes nothing, and
// Emulation.setDeviceMetricsOverride shrinks the layout viewport (and 100svh)
// with it, which would pass without Kanban doing anything. So the page gets a
// visual viewport that behaves like Chrome Android's keyboard
// (`interactive-widget=resizes-visual`): it shrinks and fires resize events
// over the keyboard's animation while the layout viewport keeps its height.

let instance: DevInstance;

test.beforeAll(async () => {
	instance = await startDevInstance();
});

test.afterAll(async () => {
	await instance?.stop();
});

const KEYBOARD_PX = 340;

interface KeyboardWindow extends Window {
	kbTestKeyboard: (covered: number, offsetTop: number) => void;
}

async function installKeyboardViewport(page: Page): Promise<void> {
	await page.addInitScript(() => {
		class KeyboardViewport extends EventTarget {
			covered = 0;
			top = 0;
			get height(): number {
				return window.innerHeight - this.covered;
			}
			get width(): number {
				return window.innerWidth;
			}
			get offsetTop(): number {
				return this.top;
			}
			get offsetLeft(): number {
				return 0;
			}
			get pageTop(): number {
				return window.scrollY + this.top;
			}
			get pageLeft(): number {
				return window.scrollX;
			}
			get scale(): number {
				return 1;
			}
		}
		const viewport = new KeyboardViewport();
		Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
		(window as unknown as KeyboardWindow).kbTestKeyboard = (covered, offsetTop) => {
			const resized = covered !== viewport.covered;
			viewport.covered = covered;
			viewport.top = offsetTop;
			viewport.dispatchEvent(new Event(resized ? "resize" : "scroll"));
		};
	});
}

// Moves the keyboard over ~160 ms in 16 ms frames, firing resize on each, as
// Chrome does while it animates.
async function animateKeyboard(page: Page, from: number, to: number): Promise<void> {
	await page.evaluate(
		async ({ from, to }) => {
			for (let step = 1; step <= 10; step += 1) {
				(window as unknown as KeyboardWindow).kbTestKeyboard(Math.round(from + ((to - from) * step) / 10), 0);
				await new Promise((resolve) => setTimeout(resolve, 16));
			}
		},
		{ from, to },
	);
}

async function expectInside(locator: Locator, top: number, bottom: number): Promise<void> {
	await expect(async () => {
		const box = await boxOf(locator);
		expect(box.top).toBeGreaterThanOrEqual(top);
		expect(box.bottom).toBeLessThanOrEqual(bottom + 0.5);
	}).toPass({ timeout: 5_000 });
}

test("the shell terminal and its touch bar stay above the keyboard, with one PTY resize per open and close", async ({
	page,
}) => {
	await installKeyboardViewport(page);
	const resizes = recordShellResizes(page);
	const { cdp, terminal } = await openShellTerminal(page, instance);
	await tapToFocus(page, cdp, terminal);
	// The touch bar under the terminal (key pad toggle, jump to bottom).
	const bar = page.getByRole("toolbar", { name: "Terminal controls" });
	await expect(bar).toBeVisible();

	const layoutHeight = await page.evaluate(() => window.innerHeight);
	const visibleBottom = layoutHeight - KEYBOARD_PX;
	// Closed, the pane runs below where the keyboard will be.
	expect((await boxOf(terminal)).bottom).toBeGreaterThan(visibleBottom);
	const before = await settledCount(resizes);
	const fullRows = resizes.at(-1);
	expect(fullRows).toBeGreaterThan(0);

	await animateKeyboard(page, 0, KEYBOARD_PX);
	await expectInside(terminal, 0, visibleBottom);
	await expectInside(bar, 0, visibleBottom);
	const opened = await settledCount(resizes);
	expect(opened - before).toBe(1);
	const openRows = resizes.at(-1) ?? 0;
	expect(openRows).toBeLessThan(fullRows ?? 0);
	// Nothing took the keyboard's focus.
	expect(await isTerminalFocused(page)).toBe(true);

	// The browser scrolls the visible part down (iOS): the pane follows, same size.
	await page.evaluate(() => (window as unknown as KeyboardWindow).kbTestKeyboard(340, 120));
	await expectInside(terminal, 120, visibleBottom + 120);
	await expectInside(bar, 120, visibleBottom + 120);
	await page.evaluate(() => (window as unknown as KeyboardWindow).kbTestKeyboard(340, 0));
	expect(await settledCount(resizes)).toBe(opened);

	await animateKeyboard(page, KEYBOARD_PX, 0);
	await expect.poll(async () => (await boxOf(terminal)).bottom).toBeGreaterThan(visibleBottom);
	const closed = await settledCount(resizes);
	expect(closed - opened).toBe(1);
	expect(resizes.at(-1)).toBe(fullRows);
	expect(await isTerminalFocused(page)).toBe(true);
});
