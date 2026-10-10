import { type CDPSession, expect, type Locator, type Page } from "@playwright/test";

import type { DevInstance } from "./dev-instance";

// The home shell terminal on a phone, driven through Chrome's input pipeline
// (CDP), for the mobile terminal specs.

export interface Point {
	x: number;
	y: number;
}

export async function tap(cdp: CDPSession, point: Point) {
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await new Promise((resolve) => setTimeout(resolve, 50));
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export async function openShellTerminal(
	page: Page,
	instance: DevInstance,
): Promise<{ cdp: CDPSession; terminal: Locator }> {
	// No "Get started" dialog over the board.
	await page.addInitScript(() => {
		window.localStorage.setItem("kanban.onboarding.dialog.shown", "true");
	});
	await page.goto(instance.baseUrl);
	// The sidebar agent's terminal may be mounted too, but hidden on a phone.
	const terminal = page.locator(".kb-terminal-container").filter({ visible: true }).first();
	// The top bar re-renders while the project loads, and the terminal may
	// still be open from the previous test.
	await expect(async () => {
		const open = page.getByRole("button", { name: "Open terminal" });
		if (await open.isEnabled({ timeout: 1_000 }).catch(() => false)) {
			await open.click({ timeout: 1_000 });
		}
		await expect(terminal).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	return { cdp: await page.context().newCDPSession(page), terminal };
}

// Taps until the terminal takes focus: the loading overlay covers it (and
// takes the taps) until the shell has drawn its prompt.
// The pane may still be settling, so this returns the terminal's centre once it focused.
export async function tapToFocus(page: Page, cdp: CDPSession, terminal: Locator): Promise<Point> {
	let center: Point = { x: 0, y: 0 };
	await expect(async () => {
		center = await terminalCenter(terminal);
		await tap(cdp, center);
		expect(await isTerminalFocused(page)).toBe(true);
	}).toPass({ timeout: 30_000 });
	return center;
}

export async function terminalCenter(terminal: Locator): Promise<Point> {
	const box = await terminal.boundingBox();
	if (!box) {
		throw new Error("The terminal has no box.");
	}
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function isTerminalFocused(page: Page): Promise<boolean> {
	return await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false);
}
