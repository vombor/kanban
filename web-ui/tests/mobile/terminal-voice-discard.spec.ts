import { type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";
import { isTerminalFocused, type Point, tap, tapToFocus } from "./terminal-page";

// The X next to the dictated text on the phone's touch bar (the orchestrator
// sidebar's agent terminal, Pixel 7 profile), tapped through real touches. It
// is the key pad toggle's size, clears the text, stops the mic, and keeps the
// keyboard's focus. iOS Safari (the user's phone, a home-screen web app) only
// makes a click of a tap that commits on the element its touch-down found
// (WebKit's WebPage::commitPotentialTap), so the X must not need that click:
// one case drops every click a touch makes.

// A stand-in for the orchestrator's agent CLI (launched as `claude`).
const FAKE_AGENT = `#!/usr/bin/env node
process.stdout.write("ORCH " + process.pid + "\\r\\n");
process.stdin.resume();
`;

// Headless Chromium has no working recognizer: this one is driven by the test
// (window.__voice), in the engines' order (start, audiostart, results, end).
function installFakeRecognizer(): void {
	interface FakeResult {
		transcript: string;
		isFinal: boolean;
	}
	class FakeRecognition extends EventTarget {
		continuous = false;
		interimResults = false;
		lang = "";
		onstart: (() => void) | null = null;
		onaudiostart: (() => void) | null = null;
		onresult: ((event: Event) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onend: (() => void) | null = null;
		aborted = false;
		stopped = false;
		start() {
			voice.sessions.push(this);
		}
		stop() {
			this.stopped = true;
		}
		abort() {
			this.aborted = true;
		}
		fire(type: string, fields: Record<string, unknown> = {}) {
			const event = Object.assign(new Event(type), fields);
			this.dispatchEvent(event);
			const handler = (this as unknown as Record<string, ((event: Event) => void) | null>)[`on${type}`];
			handler?.call(this, event);
		}
		hear(results: FakeResult[]) {
			const list = results.map((result) => Object.assign([{ transcript: result.transcript }], result));
			this.fire("result", { results: list, resultIndex: 0 });
		}
	}
	const voice = { sessions: [] as FakeRecognition[] };
	Object.assign(window, {
		SpeechRecognition: FakeRecognition,
		webkitSpeechRecognition: FakeRecognition,
		__voice: voice,
	});
}

interface FakeVoiceWindow {
	__voice: {
		sessions: Array<{
			aborted: boolean;
			stopped: boolean;
			fire: (type: string) => void;
			hear: (results: Array<{ transcript: string; isFinal: boolean }>) => void;
		}>;
	};
}

// No WebGL: xterm falls back to its DOM renderer, so the screen can be read.
test.use({
	launchOptions: {
		args: ["--disable-webgl", "--disable-webgl2"],
		...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
			: {}),
	},
});

let instance: DevInstance;

test.beforeAll(async () => {
	instance = await startDevInstance({
		fakeCommands: { claude: FAKE_AGENT },
		globalConfig: { home: 1, selectedAgentId: "claude" },
	});
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

// The sidebar's agent terminal, focused by a tap (its keyboard "open").
async function openSidebarTerminal(page: Page): Promise<CDPSession> {
	await page.addInitScript(() => {
		window.localStorage.setItem("kanban.onboarding.dialog.shown", "true");
	});
	await page.addInitScript(installFakeRecognizer);
	await page.goto(instance.baseUrl);
	const terminal = page.locator(".kb-terminal-container").filter({ visible: true });
	await expect(async () => {
		if ((await terminal.count()) === 0) {
			await page.getByRole("button", { name: "Toggle sidebar" }).click({ timeout: 1_000 });
		}
		await expect(terminal.first()).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await expect(page.locator(".xterm-rows").filter({ visible: true }).first()).toContainText("ORCH", {
		timeout: 30_000,
	});
	const cdp = await page.context().newCDPSession(page);
	await tapToFocus(page, cdp, terminal.first());
	return cdp;
}

// A mic tap, then the recognizer hears `words` (as one result, final or not).
async function dictate(page: Page, cdp: CDPSession, words: string, isFinal: boolean): Promise<number> {
	await tapButton(cdp, page.getByRole("button", { name: "Talk to the agent" }));
	const session = await page.evaluate(() => (window as unknown as FakeVoiceWindow).__voice.sessions.length - 1);
	await page.evaluate(
		({ session, words, isFinal }) => {
			const recognition = (window as unknown as FakeVoiceWindow).__voice.sessions[session];
			recognition?.fire("start");
			recognition?.fire("audiostart");
			recognition?.hear([{ transcript: words, isFinal }]);
		},
		{ session, words, isFinal },
	);
	await expect(page.getByRole("textbox", { name: "Voice message" })).toHaveValue(words);
	return session;
}

async function readSession(page: Page, session: number): Promise<{ aborted: boolean; stopped: boolean }> {
	return await page.evaluate((index) => {
		const recognition = (window as unknown as FakeVoiceWindow).__voice.sessions[index];
		return { aborted: recognition?.aborted ?? false, stopped: recognition?.stopped ?? false };
	}, session);
}

test("the X is the key pad toggle's size, and a tap while listening clears the text and stops the mic", async ({
	page,
}) => {
	const cdp = await openSidebarTerminal(page);
	const session = await dictate(page, cdp, "throw this away", false);

	const discard = page.getByRole("button", { name: "Discard voice message" });
	const toggle = page.getByRole("button", { name: "Show terminal keys" });
	const discardBox = await discard.boundingBox();
	const toggleBox = await toggle.boundingBox();
	expect(discardBox?.width).toBe(toggleBox?.width);
	expect(discardBox?.height).toBe(toggleBox?.height);
	expect(discardBox?.width).toBeGreaterThanOrEqual(44);
	// Above the row, next to the text.
	expect((discardBox?.y ?? 0) + (discardBox?.height ?? 0)).toBeLessThanOrEqual(toggleBox?.y ?? 0);
	const iconWidths = await Promise.all(
		[discard, toggle].map((button) => button.locator("svg").evaluate((icon) => icon.getBoundingClientRect().width)),
	);
	expect(iconWidths[0]).toBe(iconWidths[1]);

	await tapButton(cdp, discard);
	await expect(page.getByRole("textbox", { name: "Voice message" })).toHaveCount(0);
	expect((await readSession(page, session)).aborted).toBe(true);
	await expect(page.getByRole("button", { name: "Talk to the agent" })).toHaveAttribute("aria-pressed", "false");
	expect(await isTerminalFocused(page)).toBe(true);
	// The aborted session's late result brings nothing back.
	await page.evaluate((index) => {
		(window as unknown as FakeVoiceWindow).__voice.sessions[index]?.hear([
			{ transcript: "throw this away now", isFinal: true },
		]);
	}, session);
	await expect(page.getByRole("textbox", { name: "Voice message" })).toHaveCount(0);
});

test("a tap on the X clears the text even when the browser makes no click of the touch (iOS)", async ({ page }) => {
	const cdp = await openSidebarTerminal(page);
	// What iOS does when a tap doesn't commit on the element it went down on: the touch's events, but no click.
	await page.evaluate(() => {
		window.addEventListener(
			"click",
			(event) => {
				if (event.detail > 0) {
					event.stopImmediatePropagation();
					event.preventDefault();
				}
			},
			{ capture: true },
		);
	});
	const session = await dictate(page, cdp, "never mind", true);
	await tapButton(cdp, page.getByRole("button", { name: "Stop listening" }));
	await page.evaluate((index) => (window as unknown as FakeVoiceWindow).__voice.sessions[index]?.fire("end"), session);
	await expect(page.getByRole("textbox", { name: "Voice message" })).toHaveValue("never mind");

	await tapButton(cdp, page.getByRole("button", { name: "Discard voice message" }));
	await expect(page.getByRole("textbox", { name: "Voice message" })).toHaveCount(0);
	expect(await isTerminalFocused(page)).toBe(true);
});
