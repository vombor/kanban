import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CDPSession, expect, type Page } from "@playwright/test";

import type { DevInstance } from "./dev-instance";
import { openShellTerminal, tapToFocus } from "./terminal-page";

// A raw-stdin probe in the home shell terminal on a phone, for the mobile
// terminal input specs: the bytes the PTY got are what the probe recorded.

// Records the bytes it gets on a raw stdin, like an agent's input box does.
// With "busy" it also repaints like a thinking TUI: cursor hidden, a spinner
// and status lines rewritten every frame, the cursor parked elsewhere.
// With "app-cursor" it switches the terminal to application cursor keys
// (DECCKM) like a picker TUI, and is up once the terminal has answered a
// status report sent after the switch, so the switch has been parsed.
const INPUT_PROBE = `
const fs = require("node:fs");
const out = process.argv[2];
const mode = process.argv[4];
process.stdin.setRawMode(true);
let isUp = mode !== "app-cursor";
if (isUp) {
	fs.writeFileSync(process.argv[3], "up");
} else {
	process.stdout.write("\\x1b[?1h\\x1b[5n");
}
process.stdin.on("data", (data) => {
	if (!isUp && data.includes("\\x1b[0n")) {
		isUp = true;
		fs.writeFileSync(process.argv[3], "up");
		return;
	}
	fs.appendFileSync(out, data);
	if (data.includes("\\x03")) {
		process.stdout.write("\\x1b[?25h\\x1b[?1l");
		process.exit(0);
	}
});
if (mode === "busy") {
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

export const ENTER = "\r";
export const DEL = "\x7f";

export type InputProbeMode = "quiet" | "busy" | "app-cursor";

export async function startInputProbe(
	page: Page,
	instance: DevInstance,
	mode: InputProbeMode = "quiet",
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

export async function stopInputProbe(page: Page): Promise<void> {
	await page.keyboard.press("Control+C");
}

export async function readTextarea(
	page: Page,
): Promise<{ value: string; left: string; top: string; focused: boolean }> {
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
export async function dictate(page: Page, cdp: CDPSession, partials: string[]): Promise<void> {
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
