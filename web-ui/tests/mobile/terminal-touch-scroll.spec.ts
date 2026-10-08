import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";

// Swipe scrolling in the shared agent terminal panel on a phone (Pixel 7
// profile: touch, coarse pointer). The home shell terminal uses the same panel
// as the sidebar agent and the card agents, and its shell gives a scrollback
// we control.

let instance: DevInstance;

test.beforeAll(async () => {
	instance = await startDevInstance();
});

test.afterAll(async () => {
	await instance?.stop();
});

interface Point {
	x: number;
	y: number;
}

// Real touch events through Chrome's input pipeline (touch-action, passive
// listeners and native scrolling all apply), unlike synthetic DOM events.
async function swipe(cdp: CDPSession, from: Point, to: Point, { steps = 12, stepMs = 16, restMs = 120 } = {}) {
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
	for (let step = 1; step <= steps; step += 1) {
		const x = from.x + ((to.x - from.x) * step) / steps;
		const y = from.y + ((to.y - from.y) * step) / steps;
		await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	// Resting before lifting means no momentum, so the result is exact.
	await new Promise((resolve) => setTimeout(resolve, restMs));
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function tap(cdp: CDPSession, point: Point) {
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await new Promise((resolve) => setTimeout(resolve, 50));
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function openShellTerminal(page: Page): Promise<{ cdp: CDPSession; terminal: Locator }> {
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
async function tapToFocus(page: Page, cdp: CDPSession, terminal: Locator): Promise<Point> {
	let center: Point = { x: 0, y: 0 };
	await expect(async () => {
		center = await terminalCenter(terminal);
		await tap(cdp, center);
		expect(await isTerminalFocused(page)).toBe(true);
	}).toPass({ timeout: 30_000 });
	return center;
}

async function terminalCenter(terminal: Locator): Promise<Point> {
	const box = await terminal.boundingBox();
	if (!box) {
		throw new Error("The terminal has no box.");
	}
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function sliderTop(terminal: Locator): Promise<number> {
	return await terminal
		.locator(".xterm-scrollable-element > .scrollbar.vertical > .slider")
		.evaluate((slider) => slider.getBoundingClientRect().top);
}

async function isTerminalFocused(page: Page): Promise<boolean> {
	return await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false);
}

test("a swipe scrolls the scrollback, a fling keeps going, and Jump to bottom returns", async ({ page }) => {
	const { cdp, terminal } = await openShellTerminal(page);

	// A tap still focuses the terminal (which opens the on-screen keyboard).
	// Once ready (the panel's autoFocus has run), blur it and tap it again.
	await tapToFocus(page, cdp, terminal);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	expect(await isTerminalFocused(page)).toBe(false);
	const center = await tapToFocus(page, cdp, terminal);
	await page.keyboard.type("seq 1 600\n");
	const jumpToBottom = page.getByRole("button", { name: "Jump to bottom" });
	await expect(jumpToBottom).toHaveCount(0);
	await page.waitForTimeout(1_000);
	const bottomTop = await sliderTop(terminal);

	// Finger down: older output.
	await swipe(cdp, { x: center.x, y: center.y - 120 }, { x: center.x, y: center.y + 120 });
	await expect(jumpToBottom).toBeVisible();
	const afterSwipe = await sliderTop(terminal);
	expect(afterSwipe).toBeLessThan(bottomTop);
	// The swipe didn't type anything or blur the terminal.
	expect(await isTerminalFocused(page)).toBe(true);

	// A fast fling keeps scrolling after the finger lifts.
	await swipe(
		cdp,
		{ x: center.x, y: center.y - 100 },
		{ x: center.x, y: center.y + 100 },
		{
			steps: 5,
			stepMs: 8,
			restMs: 0,
		},
	);
	const atRelease = await sliderTop(terminal);
	await page.waitForTimeout(800);
	expect(await sliderTop(terminal)).toBeLessThan(atRelease);

	await jumpToBottom.tap();
	await expect(jumpToBottom).toHaveCount(0);
	expect(await sliderTop(terminal)).toBeCloseTo(bottomTop, 0);
	// Tapping the button kept the terminal focused (the keyboard stays open).
	expect(await isTerminalFocused(page)).toBe(true);

	// Finger up from the bottom stays at the bottom.
	await swipe(cdp, { x: center.x, y: center.y + 100 }, { x: center.x, y: center.y - 100 });
	await expect(jumpToBottom).toHaveCount(0);
});

test("a long-press is left alone, and so are horizontal swipes", async ({ page }) => {
	const { cdp, terminal } = await openShellTerminal(page);
	const center = await tapToFocus(page, cdp, terminal);
	await page.keyboard.type("seq 1 600\n");
	await page.waitForTimeout(1_000);
	const bottomTop = await sliderTop(terminal);

	// Hold, then drag (a selection drag): no scroll.
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [center] });
	await page.waitForTimeout(600);
	for (let step = 1; step <= 8; step += 1) {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x: center.x, y: center.y + step * 15 }],
		});
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	expect(await sliderTop(terminal)).toBeCloseTo(bottomTop, 0);

	await swipe(cdp, { x: center.x + 120, y: center.y }, { x: center.x - 120, y: center.y + 10 });
	expect(await sliderTop(terminal)).toBeCloseTo(bottomTop, 0);
	await expect(page.getByRole("button", { name: "Jump to bottom" })).toHaveCount(0);
});

// What a full-screen agent TUI does (Claude Code fullscreen, Cline --tui,
// Codex, Copilot): alternate screen plus SGR mouse reporting. It records the
// bytes it gets, so the test sees the wheel reports a swipe sends.
const WHEEL_PROBE = `
const fs = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HWHEEL PROBE READY");
process.stdin.on("data", (data) => {
	fs.appendFileSync(out, data);
	if (data.includes("q")) {
		process.stdout.write("\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l");
		process.exit(0);
	}
});
`;

const ESC = "\u001b";
// SGR wheel reports: button 64 is wheel up, 65 wheel down.
const WHEEL_UP = `${ESC}[<64;`;
const WHEEL_DOWN = `${ESC}[<65;`;

function countOf(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

test("on a full-screen TUI with mouse reporting a swipe sends wheel reports", async ({ page }) => {
	const probePath = join(instance.rootDir, "wheel-probe.cjs");
	const outPath = join(instance.rootDir, "wheel-probe.out");
	writeFileSync(probePath, WHEEL_PROBE);
	writeFileSync(outPath, "");
	const { cdp, terminal } = await openShellTerminal(page);
	const center = await tapToFocus(page, cdp, terminal);
	await page.keyboard.type(`node ${probePath} ${outPath}\n`);
	// xterm marks the terminal once the app turned mouse reporting on.
	await expect(terminal.locator(".xterm.enable-mouse-events")).toHaveCount(1, { timeout: 10_000 });
	const readProbe = () => readFileSync(outPath, "utf8");
	// The tap above went in before the probe started; nothing is recorded yet.
	expect(readProbe()).toBe("");

	// Finger down = wheel up (SGR button 64), at the cell under the finger.
	await swipe(cdp, { x: center.x, y: center.y - 100 }, { x: center.x, y: center.y + 100 });
	await expect.poll(() => countOf(readProbe(), WHEEL_UP)).toBeGreaterThan(1);
	expect(countOf(readProbe(), WHEEL_DOWN)).toBe(0);
	// No arrow keys: those would recall prompt history in an agent's input.
	for (const arrow of [`${ESC}[A`, `${ESC}[B`, `${ESC}OA`, `${ESC}OB`]) {
		expect(countOf(readProbe(), arrow)).toBe(0);
	}

	await swipe(cdp, { x: center.x, y: center.y + 100 }, { x: center.x, y: center.y - 100 });
	await expect.poll(() => countOf(readProbe(), WHEEL_DOWN)).toBeGreaterThan(1);
	// The app owns scrolling there: no Jump to bottom.
	await expect(page.getByRole("button", { name: "Jump to bottom" })).toHaveCount(0);
	await page.keyboard.type("q");
});
