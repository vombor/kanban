import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CDPSession, expect, type Page, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";
import { openShellTerminal, tapToFocus } from "./terminal-page";

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
const INPUT_PROBE = `
const fs = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
fs.writeFileSync(process.argv[3], "up");
process.stdin.on("data", (data) => {
	fs.appendFileSync(out, data);
	if (data.includes("\\x03")) {
		process.exit(0);
	}
});
`;

const ENTER = "\r";
const DEL = "\x7f";

async function startInputProbe(page: Page): Promise<{ cdp: CDPSession; readProbe: () => string }> {
	const probePath = join(instance.rootDir, "input-probe.cjs");
	const outPath = join(instance.rootDir, "input-probe.out");
	const readyPath = join(instance.rootDir, "input-probe.ready");
	writeFileSync(probePath, INPUT_PROBE);
	writeFileSync(outPath, "");
	writeFileSync(readyPath, "");
	const { cdp, terminal } = await openShellTerminal(page, instance);
	await tapToFocus(page, cdp, terminal);
	// The WebGL renderer draws no DOM text, so the probe says it is up through a file.
	await page.keyboard.type(`node ${probePath} ${outPath} ${readyPath}\n`);
	await expect.poll(() => readFileSync(readyPath, "utf8")).toContain("up");
	return { cdp, readProbe: () => readFileSync(outPath, "utf8") };
}

async function stopInputProbe(page: Page): Promise<void> {
	await page.keyboard.press("Control+C");
}

test("dictation that takes back its interim results reaches the PTY once", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page);

	// Gboard voice typing: each new hypothesis deletes the last one (no key
	// event, inputType deleteContentBackward) and commits the new one (insertText).
	let committed = 0;
	for (const partial of ["l", "let", "let me", "let me know", "let me know when"]) {
		if (committed > 0) {
			await cdp.send("Input.imeSetComposition", {
				text: "",
				selectionStart: 0,
				selectionEnd: 0,
				replacementStart: 0,
				replacementEnd: committed,
			});
			await page.waitForTimeout(20);
		}
		await cdp.send("Input.insertText", { text: partial });
		committed = partial.length;
		await page.waitForTimeout(60);
	}
	await page.keyboard.press("Enter");
	await expect.poll(readProbe).toBe(`let me know when${ENTER}`);

	// A hypothesis that changes an earlier word: Backspaces up to the change, then the rest.
	committed = 0;
	for (const partial of ["see", "sea", "sea shells"]) {
		if (committed > 0) {
			await cdp.send("Input.imeSetComposition", {
				text: "",
				selectionStart: 0,
				selectionEnd: 0,
				replacementStart: 0,
				replacementEnd: committed,
			});
			await page.waitForTimeout(20);
		}
		await cdp.send("Input.insertText", { text: partial });
		committed = partial.length;
		await page.waitForTimeout(60);
	}
	await page.keyboard.press("Enter");
	await expect.poll(readProbe).toBe(`let me know when${ENTER}see${DEL}a shells${ENTER}`);
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
