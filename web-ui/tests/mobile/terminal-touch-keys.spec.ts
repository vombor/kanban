import { type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";
import { dictate, ENTER, readTextarea, startInputProbe, stopInputProbe } from "./input-probe";
import {
	boxOf,
	isTerminalFocused,
	openShellTerminal,
	type Point,
	recordShellResizes,
	settledCount,
	tap,
	tapToFocus,
} from "./terminal-page";

// The touch bar under the agent terminal panel (Pixel 7 profile): the keys a
// phone keyboard lacks to answer a TUI's picker, tapped through real touches.
// The PTY must get the terminal's own sequences, and the textarea keeps the
// keyboard's focus and text.

let instance: DevInstance;

test.beforeAll(async () => {
	instance = await startDevInstance();
});

test.afterAll(async () => {
	await instance?.stop();
});

async function centerOf(button: Locator): Promise<Point> {
	await expect(button).toBeVisible();
	const box = await button.boundingBox();
	if (!box) {
		throw new Error("The button has no box.");
	}
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tapButton(cdp: CDPSession, button: Locator): Promise<void> {
	await tap(cdp, await centerOf(button));
}

async function openKeyPad(page: Page, cdp: CDPSession): Promise<void> {
	const show = page.getByRole("button", { name: "Show terminal keys" });
	if (await show.isVisible()) {
		await tapButton(cdp, show);
	}
	await expect(page.getByRole("toolbar", { name: "Terminal keys" })).toBeVisible();
}

test("Down then the bar's Enter answers a picker, and the keyboard keeps its focus", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page, instance);
	const before = await readTextarea(page);
	await openKeyPad(page, cdp);

	await tapButton(cdp, page.getByRole("button", { name: "Send Down" }));
	await tapButton(cdp, page.getByRole("button", { name: "Send Enter" }));
	await expect.poll(readProbe).toBe(`\x1b[B${ENTER}`);
	expect(await isTerminalFocused(page)).toBe(true);

	// A multi-select question: Space toggles, Tab and Shift+Tab move, Esc leaves.
	for (const name of ["Send Space", "Send Tab", "Send Shift+Tab", "Send Up", "Send Left", "Send Right", "Send Esc"]) {
		await tapButton(cdp, page.getByRole("button", { name }));
	}
	await expect.poll(readProbe).toBe(`\x1b[B${ENTER} \t\x1b[Z\x1b[A\x1b[D\x1b[C\x1b`);
	const after = await readTextarea(page);
	expect(after.focused).toBe(true);
	expect(after.value).toBe(before.value);
	await stopInputProbe(page);
});

test("the bar's Enter sends the dictation so far, and the keyboard keeps dictating after it", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page, instance);
	const before = await readTextarea(page);

	await dictate(page, cdp, ["l", "let", "let me", "let me know"]);
	await tapButton(cdp, page.getByRole("button", { name: "Send Enter" }));
	await expect.poll(readProbe).toBe(`let me know${ENTER}`);
	// The keyboard's own submit: the textarea keeps its text and focus, so its voice input isn't reset.
	expect(await isTerminalFocused(page)).toBe(true);
	expect((await readTextarea(page)).value).toBe(`${before.value}let me know`);

	// What was sent is final: only the new words go out, never a Backspace into the sent line.
	await dictate(page, cdp, [" when", " when it is done"]);
	await tapButton(cdp, page.getByRole("button", { name: "Send Enter" }));
	await expect.poll(readProbe).toBe(`let me know${ENTER} when it is done${ENTER}`);
	expect(await isTerminalFocused(page)).toBe(true);
	await stopInputProbe(page);
});

test("arrows follow the TUI's application cursor-key mode", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page, instance, "app-cursor");
	await openKeyPad(page, cdp);

	await tapButton(cdp, page.getByRole("button", { name: "Send Down" }));
	await tapButton(cdp, page.getByRole("button", { name: "Send Up" }));
	await expect.poll(readProbe).toBe("\x1bOB\x1bOA");
	await stopInputProbe(page);
});

test("dictation still pending goes out before the key", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page, instance);
	await openKeyPad(page, cdp);

	await dictate(page, cdp, ["t", "two"]);
	await tapButton(cdp, page.getByRole("button", { name: "Send Down" }));
	await expect.poll(readProbe).toBe("two\x1b[B");
	// The keyboard keeps dictating after the key: only the new words go out.
	await dictate(page, cdp, [" more"]);
	await expect.poll(readProbe).toBe("two\x1b[B more");
	expect(await isTerminalFocused(page)).toBe(true);
	await stopInputProbe(page);
});

test("a held arrow repeats", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page, instance);
	await openKeyPad(page, cdp);

	const point = await centerOf(page.getByRole("button", { name: "Send Down" }));
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await page.waitForTimeout(800);
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await expect.poll(() => readProbe().split("\x1b[B").length - 1).toBeGreaterThanOrEqual(3);
	// Nothing more once released.
	const count = readProbe().length;
	await page.waitForTimeout(300);
	expect(readProbe().length).toBe(count);
	expect(readProbe().replaceAll("\x1b[B", "")).toBe("");
	expect(await isTerminalFocused(page)).toBe(true);
	await stopInputProbe(page);
});

test("the bar sits under the terminal, and its key pad refits the terminal once each way", async ({ page }) => {
	// A small phone: every key still fits on one row.
	await page.setViewportSize({ width: 360, height: 780 });
	const resizes = recordShellResizes(page);
	const { cdp, terminal } = await openShellTerminal(page, instance);
	await tapToFocus(page, cdp, terminal);
	const bar = page.getByRole("toolbar", { name: "Terminal controls" });
	const before = await settledCount(resizes);
	const fullRows = resizes.at(-1) ?? 0;
	// Below the TUI, never over it.
	expect((await boxOf(bar)).top).toBeGreaterThanOrEqual((await boxOf(terminal)).bottom - 0.5);
	// One row: the key pad toggle and the round Enter (a shell has no voice), thumb-sized, at the row's right edge.
	const rowButtons = await bar.getByRole("button").evaluateAll((buttons) =>
		buttons.map((button) => {
			const rect = button.getBoundingClientRect();
			return {
				label: button.getAttribute("aria-label"),
				top: rect.top,
				right: rect.right,
				width: rect.width,
				height: rect.height,
			};
		}),
	);
	expect(rowButtons.map((button) => button.label)).toEqual(["Show terminal keys", "Send Enter"]);
	const barBox = await bar.boundingBox();
	expect(rowButtons[1]?.right ?? 0).toBeGreaterThan((barBox?.x ?? 0) + (barBox?.width ?? 0) - 1);
	expect(new Set(rowButtons.map((button) => Math.round(button.top))).size).toBe(1);
	for (const button of rowButtons) {
		expect(Math.min(button.width, button.height), button.label ?? "").toBeGreaterThanOrEqual(40);
	}

	await openKeyPad(page, cdp);
	const keys = page.getByRole("toolbar", { name: "Terminal keys" });
	// Every key on one row, inside the width.
	const keyBoxes = await keys.getByRole("button").evaluateAll((buttons) =>
		buttons.map((button) => {
			const rect = button.getBoundingClientRect();
			return { top: rect.top, left: rect.left, right: rect.right };
		}),
	);
	expect(keyBoxes).toHaveLength(8);
	expect(new Set(keyBoxes.map((box) => Math.round(box.top))).size).toBe(1);
	const viewportWidth = await page.evaluate(() => window.innerWidth);
	expect(Math.max(...keyBoxes.map((box) => box.right))).toBeLessThanOrEqual(viewportWidth);
	expect((await boxOf(keys)).top).toBeGreaterThanOrEqual((await boxOf(terminal)).bottom - 0.5);
	const opened = await settledCount(resizes);
	expect(opened - before).toBe(1);
	expect(resizes.at(-1)).toBeLessThan(fullRows);
	expect(await isTerminalFocused(page)).toBe(true);

	await tapButton(cdp, page.getByRole("button", { name: "Hide terminal keys" }));
	await expect(keys).toHaveCount(0);
	const closed = await settledCount(resizes);
	expect(closed - opened).toBe(1);
	expect(resizes.at(-1)).toBe(fullRows);
	expect(await isTerminalFocused(page)).toBe(true);
});
