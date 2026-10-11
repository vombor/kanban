import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CDPSession, expect, type Page, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";
import { isTerminalFocused, openShellTerminal, tap, tapToFocus } from "./terminal-page";

// Phone keyboard and dictation input into the shared agent terminal panel
// (Pixel 7 profile), through Chrome's real IME pipeline (CDP Input.ime*):
// the PTY must get the dictated text once, not every interim result.

let instance: DevInstance;

test.beforeAll(async () => {
	instance = await startDevInstance();
});

test.afterAll(async () => {
	await instance?.stop();
});

// Records the bytes it gets on a raw stdin, like an agent's input box does.
// With "busy" it also repaints like a thinking TUI: cursor hidden, a spinner
// and status lines rewritten every frame, the cursor parked elsewhere.
const INPUT_PROBE = `
const fs = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
fs.writeFileSync(process.argv[3], "up");
process.stdin.on("data", (data) => {
	fs.appendFileSync(out, data);
	if (data.includes("\\x03")) {
		process.stdout.write("\\x1b[?25h");
		process.exit(0);
	}
});
if (process.argv[4] === "busy") {
	const frames = ["✻", "✽", "✶", "✳", "✢", "·"];
	let frame = 0;
	process.stdout.write("\\x1b[?25l\\n\\n\\n\\n");
	setInterval(() => {
		frame += 1;
		let paint = "\\x1b[4A\\r";
		paint += "\\x1b[2K" + frames[frame % frames.length] + " Thinking… 🤔 (" + frame + ")\\n";
		paint += "\\x1b[2K" + "─".repeat(30) + "\\n";
		paint += "\\x1b[2K> \\n";
		paint += "\\x1b[2K" + "x".repeat(frame % 40) + "\\n";
		if (frame % 2) {
			paint += "\\x1b[4A\\x1b[15G\\x1b[4B";
		}
		process.stdout.write(paint);
	}, 16);
}
`;

const ENTER = "\r";
const DEL = "\x7f";

async function startInputProbe(
	page: Page,
	mode: "quiet" | "busy" = "quiet",
): Promise<{ cdp: CDPSession; readProbe: () => string }> {
	const probePath = join(instance.rootDir, "input-probe.cjs");
	const outPath = join(instance.rootDir, "input-probe.out");
	const readyPath = join(instance.rootDir, "input-probe.ready");
	writeFileSync(probePath, INPUT_PROBE);
	writeFileSync(outPath, "");
	writeFileSync(readyPath, "");
	const { cdp, terminal } = await openShellTerminal(page, instance);
	await tapToFocus(page, cdp, terminal);
	// The WebGL renderer draws no DOM text, so the probe says it is up through a file.
	await page.keyboard.type(`node ${probePath} ${outPath} ${readyPath} ${mode}\n`);
	await expect.poll(() => readFileSync(readyPath, "utf8")).toContain("up");
	return { cdp, readProbe: () => readFileSync(outPath, "utf8") };
}

async function stopInputProbe(page: Page): Promise<void> {
	await page.keyboard.press("Control+C");
}

async function readTextarea(page: Page): Promise<{ value: string; left: string; top: string; focused: boolean }> {
	return await page.evaluate(() => {
		const textarea = document.querySelector(".kb-terminal-container .xterm-helper-textarea");
		if (!(textarea instanceof HTMLTextAreaElement)) {
			throw new Error("No terminal textarea.");
		}
		const style = getComputedStyle(textarea);
		return {
			value: textarea.value,
			left: style.left,
			top: style.top,
			focused: document.activeElement === textarea,
		};
	});
}

// Gboard voice typing: each new hypothesis deletes the last one (no key event,
// inputType deleteContentBackward) and commits the new one (insertText), at the
// end of whatever the textarea already holds.
async function dictate(page: Page, cdp: CDPSession, partials: string[]): Promise<void> {
	const start = (await readTextarea(page)).value.length;
	let committed = 0;
	for (const partial of partials) {
		if (committed > 0) {
			await cdp.send("Input.imeSetComposition", {
				text: "",
				selectionStart: 0,
				selectionEnd: 0,
				replacementStart: start,
				replacementEnd: start + committed,
			});
			await page.waitForTimeout(20);
		}
		await cdp.send("Input.insertText", { text: partial });
		committed = partial.length;
		await page.waitForTimeout(60);
	}
}

test("dictation that takes back its interim results reaches the PTY once", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page);

	await dictate(page, cdp, ["l", "let", "let me", "let me know", "let me know when"]);
	await page.keyboard.press("Enter");
	await expect.poll(readProbe).toBe(`let me know when${ENTER}`);

	// A hypothesis that changes an earlier word: Backspaces up to the change, then the rest.
	await dictate(page, cdp, ["see", "sea", "sea shells"]);
	await page.keyboard.press("Enter");
	await expect.poll(readProbe).toBe(`let me know when${ENTER}see${DEL}a shells${ENTER}`);
	await stopInputProbe(page);
});

test("dictation keeps going across sends while the TUI repaints", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page, "busy");
	const enterButton = page.getByRole("button", { name: "Send Enter" });
	await expect(enterButton).toBeVisible();

	// xterm moves its textarea to the cursor on every cursor move; on a phone it stays put.
	// (It still holds the probe command's Shift+letters: real keys are xterm's.)
	const before = await readTextarea(page);
	await dictate(page, cdp, ["l", "let", "let me", "let me know"]);
	await expect.poll(readProbe).toBe("let me know");

	// The panel's Enter: the dictation so far and Enter go out, the textarea
	// keeps its text and its focus, so the keyboard's voice input isn't reset.
	const box = await enterButton.boundingBox();
	if (!box) {
		throw new Error("The Enter button has no box.");
	}
	await tap(cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
	await expect.poll(readProbe).toBe(`let me know${ENTER}`);
	expect(await isTerminalFocused(page)).toBe(true);
	expect((await readTextarea(page)).value).toBe(`${before.value}let me know`);

	// Still listening: the next phrase arrives once, the sent one never again.
	await dictate(page, cdp, [" when", " when it", " when it is done"]);
	for (const partial of [" and", " and then"]) {
		await cdp.send("Input.imeSetComposition", {
			text: partial,
			selectionStart: partial.length,
			selectionEnd: partial.length,
		});
		await page.waitForTimeout(40);
	}
	await cdp.send("Input.insertText", { text: " and then" });
	await page.waitForTimeout(100);
	// The keyboard's own Enter doesn't empty the textarea either.
	await page.keyboard.press("Enter");
	await expect.poll(readProbe).toBe(`let me know${ENTER} when it is done and then${ENTER}`);
	const after = await readTextarea(page);
	expect(after.focused).toBe(true);
	expect(after.value).toBe(`${before.value}let me know when it is done and then`);
	expect({ left: after.left, top: after.top }).toEqual({ left: before.left, top: before.top });

	await dictate(page, cdp, [" ok"]);
	await expect.poll(readProbe).toBe(`let me know${ENTER} when it is done and then${ENTER} ok`);
	await stopInputProbe(page);
});

test("a composition that grows is sent once, at its end", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page);

	for (const partial of ["l", "let", "let me", "let me know", "let me know when"]) {
		await cdp.send("Input.imeSetComposition", {
			text: partial,
			selectionStart: partial.length,
			selectionEnd: partial.length,
		});
		await page.waitForTimeout(40);
	}
	// Nothing reaches the PTY while the IME is still composing.
	await page.waitForTimeout(400);
	expect(readProbe()).toBe("");
	await cdp.send("Input.insertText", { text: "let me know when" });
	await page.keyboard.press("Enter");
	await expect.poll(readProbe).toBe(`let me know when${ENTER}`);

	// Keys typed on a keyboard still go straight in.
	await page.keyboard.type("ok");
	await page.keyboard.press("Enter");
	await expect.poll(readProbe).toBe(`let me know when${ENTER}ok${ENTER}`);
	await stopInputProbe(page);
});
