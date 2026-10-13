import { devices, expect, type Locator, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";

// The board card on a phone (the config's Pixel 7) and on a narrow desktop column: a header strip across the card's top
// with the task id and live tokens, and the agent row with the agent pill (the effective agent, the selected one for a card that names
// none) on the left and, right-justified on the same line, a Backlog card's prerequisites or a running card's time.
// The row never wraps: the model text truncates first, the time stays whole. A card that
// names no model shows the model its sessions used, read from the agent's own transcript.

// A stand-in for Claude Code that stays running, so its card sits In Progress, and writes a transcript where Claude
// Code does (one 1,500-token message every second, with its model), so the card's token count grows while it runs.
const FAKE_AGENT = `#!/usr/bin/env node
const { appendFileSync, mkdirSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const dir = join(homedir(), ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });
let n = 0;
setInterval(() => {
	n += 1;
	const usage = { input_tokens: 1000, output_tokens: 500 };
	const message = { id: "m" + n, model: "claude-opus-5-5", usage };
	const line = { type: "assistant", timestamp: new Date().toISOString(), message };
	appendFileSync(join(dir, "fake.jsonl"), JSON.stringify(line) + "\\n");
}, 1000);
process.stdout.write("working\\r\\n");
process.stdin.resume();
`;

const LONG_MODEL = "us.anthropic.claude-opus-5-5-with-a-very-long-model-name-for-truncation";

test.use({
	launchOptions: {
		...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
			: {}),
	},
});

let instance: DevInstance;
let runningTaskId = "";
let backlogTaskId = "";

function runCliJson(args: string[]): Record<string, unknown> {
	const result = instance.runCli(args);
	if (result.status !== 0) {
		throw new Error(`kanban ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

function readTaskId(response: Record<string, unknown>): string {
	const task = response.task as { id?: unknown } | undefined;
	if (typeof task?.id !== "string") {
		throw new Error(`No task id in ${JSON.stringify(response)}`);
	}
	return task.id;
}

test.beforeAll(async () => {
	instance = await startDevInstance({
		fakeCommands: { claude: FAKE_AGENT },
		globalConfig: { selectedAgentId: "claude" },
	});
	const projectPath = instance.projectDir;
	runningTaskId = readTaskId(
		runCliJson([
			"task",
			"create",
			"--title",
			"Fix the login form",
			"--prompt",
			"Fix it",
			"--project-path",
			projectPath,
		]),
	);
	backlogTaskId = readTaskId(
		runCliJson([
			"task",
			"create",
			"--title",
			"Long model card",
			"--prompt",
			"Later",
			"--agent-id",
			"claude",
			"--model",
			LONG_MODEL,
			"--project-path",
			projectPath,
		]),
	);
	runCliJson(["task", "start", "--task-id", runningTaskId, "--project-path", projectPath]);
	// The Backlog card waits on the running one: "Waiting on 1 of 1" on its agent row.
	runCliJson([
		"task",
		"link",
		"--task-id",
		backlogTaskId,
		"--linked-task-id",
		runningTaskId,
		"--project-path",
		projectPath,
	]);
});

test.afterAll(async () => {
	await instance?.stop();
});

async function expectOneLine(first: Locator, second: Locator): Promise<void> {
	const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
	expect(a && b).toBeTruthy();
	if (!a || !b) {
		return;
	}
	// Same line: their vertical centres sit within a couple of pixels.
	expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(3);
	expect(b.x).toBeGreaterThan(a.x + a.width - 1);
}

// Same height: one line each.
async function expectSameHeight(first: Locator, second: Locator): Promise<void> {
	const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
	expect(Math.abs((a?.height ?? 0) - (b?.height ?? 99))).toBeLessThan(1);
}

// At the right end of its row.
async function expectRightJustified(inner: Locator, outer: Locator): Promise<void> {
	const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
	const inset = await outer.evaluate((element) => {
		const style = getComputedStyle(element);
		return Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth);
	});
	expect(a && b).toBeTruthy();
	if (a && b) {
		expect(Math.abs(b.x + b.width - inset - (a.x + a.width))).toBeLessThan(1);
	}
}

// The pill's text truncates inside it and never spills out over the run stats or prerequisites.
async function expectContentInside(pill: Locator): Promise<void> {
	const overflow = await pill.evaluate((element) => {
		const box = element.getBoundingClientRect();
		// A fully truncated span is 0 px wide and draws nothing, wherever the gap puts it.
		const drawn = Array.from(element.children, (child) => child.getBoundingClientRect()).filter(
			(rect) => rect.width >= 1,
		);
		return Math.max(0, ...drawn.map((rect) => rect.right - box.right));
	});
	expect(overflow).toBeLessThan(0.5);
}

// The text fits its box, with no ellipsis.
async function expectNotTruncated(text: Locator): Promise<void> {
	expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

// A strip across the card: flush with its top and as wide as the card inside its 1-px border.
async function expectHeaderStrip(header: Locator, card: Locator): Promise<void> {
	const [a, b] = await Promise.all([header.boundingBox(), card.boundingBox()]);
	expect(a && b).toBeTruthy();
	if (a && b) {
		expect(Math.abs(a.y - b.y)).toBeLessThan(1.5);
		expect(Math.abs(a.width - b.width)).toBeLessThan(2.5);
	}
}

const { defaultBrowserType: _desktopBrowserType, ...desktopChrome } = devices["Desktop Chrome"];

for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") {
			// A small window gives the board its narrowest columns.
			test.use({ ...desktopChrome, viewport: { width: 900, height: 800 } });
		}

		test("the card shows token consumption in its header and running time or prerequisites beside the agent", async ({
			page,
		}, testInfo) => {
			await page.addInitScript(() => {
				window.localStorage.setItem("kanban.onboarding.dialog.shown", "true");
			});
			await page.goto(instance.baseUrl);

			const running = page.locator(`[data-task-id="${runningTaskId}"]`).filter({ visible: true }).first();
			// On a phone the columns scroll sideways.
			await expect(running).toBeVisible({ timeout: 30_000 });
			await running.scrollIntoViewIfNeeded();
			const header = running.getByTestId("board-card-header");
			const taskId = header.getByTestId("board-card-task-id");
			await expect(taskId).toHaveText(runningTaskId);
			await expectHeaderStrip(header, running);
			const row = running.getByTestId("board-card-meta-row");
			const pill = row.getByTestId("board-card-agent");
			// The card names no model: the pill shows the one its transcript names, where a Cline card's model goes.
			await expect(pill).toHaveText("Claude Code · claude-opus-5-5", { timeout: 30_000 });
			await expect(pill.getByTestId("board-card-agent-model")).toHaveText("· claude-opus-5-5");
			await expect(row.getByTestId("board-card-task-id")).toHaveCount(0);
			const stats = row.getByTestId("board-card-running-time");
			const tokens = header.getByTestId("board-card-token-usage");
			await expect(stats).toHaveText(/^\d+(s|m)$/u, { timeout: 30_000 });
			await expect(tokens).toHaveText(/^\d+(\.\d)?k↓ \d+(\.\d)?k?↑$/u, { timeout: 30_000 });
			await expect(tokens).toHaveAttribute("aria-label", /^\d+(\.\d)?k tokens in, \d+(\.\d)?k? tokens out$/u);
			await expectOneLine(pill, stats);
			await expectContentInside(pill);
			await expectRightJustified(stats, row);
			await expectOneLine(taskId, tokens);
			await expectRightJustified(tokens, header);
			await expectOneLine(tokens.getByTestId("board-card-tokens-in"), tokens.getByTestId("board-card-tokens-out"));
			const readTokens = async () =>
				Number.parseFloat((await tokens.getByTestId("board-card-tokens-in").textContent()) ?? "");
			const before = await readTokens();
			await expect.poll(readTokens, { timeout: 20_000 }).toBeGreaterThan(before);
			await testInfo.attach("running card", { body: await running.screenshot(), contentType: "image/png" });

			const backlog = page.locator(`[data-task-id="${backlogTaskId}"]`).filter({ visible: true }).first();
			await backlog.scrollIntoViewIfNeeded();
			const backlogHeader = backlog.getByTestId("board-card-header");
			await expect(backlogHeader.getByTestId("board-card-task-id")).toHaveText(backlogTaskId);
			await expectHeaderStrip(backlogHeader, backlog);
			const backlogRow = backlog.getByTestId("board-card-meta-row");
			const backlogPill = backlogRow.getByTestId("board-card-agent");
			await expect(backlogPill).toHaveText(`Claude Code · ${LONG_MODEL}`);
			await expect(backlog.getByTestId("board-card-running-time")).toHaveCount(0);
			const waiting = backlogRow.getByTestId("board-card-prerequisites");
			await expect(waiting).toHaveText("Waiting on 1 of 1");
			if (profile === "phone") {
				// A phone's column has room for the whole label: it doesn't give up characters while the pill can shrink.
				await expectNotTruncated(waiting.locator(".truncate"));
				await expectNotTruncated(backlogPill.locator(".truncate").first());
			}
			// The long model truncates inside the pill, and on the narrowest columns the agent name too; the prerequisites
			// stay whole on the same line, at its right end, as tall as the pill.
			await expectOneLine(backlogPill, waiting);
			await expectContentInside(backlogPill);
			await expectRightJustified(waiting, backlogRow);
			await expectSameHeight(backlogPill, waiting);
			await testInfo.attach("backlog card", { body: await backlog.screenshot(), contentType: "image/png" });
		});
	});
}
