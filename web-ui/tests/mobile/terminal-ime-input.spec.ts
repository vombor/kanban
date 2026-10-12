import { expect, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";
import { DEL, dictate, ENTER, readTextarea, startInputProbe, stopInputProbe } from "./input-probe";
import { isTerminalFocused } from "./terminal-page";

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

test("dictation that takes back its interim results reaches the PTY once", async ({ page }) => {
	const { cdp, readProbe } = await startInputProbe(page, instance);

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
	const { cdp, readProbe } = await startInputProbe(page, instance, "busy");

	// xterm moves its textarea to the cursor on every cursor move; on a phone it stays put.
	// (It still holds the probe command's Shift+letters: real keys are xterm's.)
	const before = await readTextarea(page);
	await dictate(page, cdp, ["l", "let", "let me", "let me know"]);
	await expect.poll(readProbe).toBe("let me know");

	// The keyboard's Enter: the dictation so far and Enter go out, the textarea
	// keeps its text and its focus, so the keyboard's voice input isn't reset.
	await page.keyboard.press("Enter");
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
	// Again after more dictation and a composition: the textarea keeps its text.
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
	const { cdp, readProbe } = await startInputProbe(page, instance);

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
