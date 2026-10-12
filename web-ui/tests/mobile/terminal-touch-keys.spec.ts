import { type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";
import { dictate, ENTER, readTextarea, startInputProbe, stopInputProbe } from "./input-probe";
import { isTerminalFocused, type Point, tap } from "./terminal-page";

// The touch key bar of the agent terminal panel (Pixel 7 profile): the keys a
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

test("Down then Enter answers a picker, and the keyboard keeps its focus", async ({ page }) => {
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
