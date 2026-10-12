import { devices, expect, type Locator, test } from "@playwright/test";

import { type DevInstance, startDevInstance } from "./dev-instance";

// The board card's agent row on a phone (the config's Pixel 7) and on a narrow desktop column: the task id pill, then
// the agent pill (the effective agent, the selected one for a card that names none), and under them the centered
// second row with a Backlog card's prerequisites, or a running card's live token count and running time. The id never
// wraps and the pill stays on its line; the model text truncates first.

// A stand-in for Claude Code that stays running, so its card sits In Progress, and writes a transcript where Claude
// Code does (one 1,500-token message every second), so the card's token count grows while it runs.
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
	appendFileSync(join(dir, "fake.jsonl"), JSON.stringify({ type: "assistant", message: { id: "m" + n, usage } }) + "\\n");
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
	// The Backlog card waits on the running one: "Waiting on 1 of 1" in its second row.
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

// Same height (the id pill is shaped like the agent pill).
async function expectSameHeight(first: Locator, second: Locator): Promise<void> {
	const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
	expect(Math.abs((a?.height ?? 0) - (b?.height ?? 99))).toBeLessThan(1);
}

// Centered in the card's line: equal space left and right.
async function expectCentered(inner: Locator, outer: Locator): Promise<void> {
	const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
	expect(a && b).toBeTruthy();
	if (a && b) {
		expect(Math.abs(a.x - b.x - (b.x + b.width - (a.x + a.width)))).toBeLessThan(2);
	}
}

async function expectInside(inner: Locator, outer: Locator): Promise<void> {
	const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
	expect(a && b).toBeTruthy();
	if (a && b) {
		expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
	}
}

const { defaultBrowserType: _desktopBrowserType, ...desktopChrome } = devices["Desktop Chrome"];

for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") {
			// A small window gives the board its narrowest columns.
			test.use({ ...desktopChrome, viewport: { width: 900, height: 800 } });
		}

		test("the card shows the task id pill, then the agent pill, and a Backlog card its prerequisites below", async ({
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
			const taskId = running.getByTestId("board-card-task-id");
			const pill = running.getByTestId("board-card-agent");
			await expect(taskId).toHaveText(runningTaskId);
			await expect(pill).toHaveText("Claude Code");
			// No token count on the agent line: the second row takes it.
			await expect(running.getByTestId("board-card-meta-row").getByTestId("board-card-token-usage")).toHaveCount(0);
			await expectOneLine(taskId, pill);
			await expectSameHeight(taskId, pill);
			await expectInside(pill, running.getByTestId("board-card-meta-row"));
			// The second row: the live token count and running time, centered under the line, growing while it runs.
			const stats = running.getByTestId("board-card-second-row");
			await expect(stats).toHaveText(/^\d+(\.\d)?k tok·\d+(s|m)$/u, { timeout: 30_000 });
			const [tokens, time, line] = await Promise.all([
				stats.getByTestId("board-card-token-usage").boundingBox(),
				stats.getByTestId("board-card-running-time").boundingBox(),
				running.getByTestId("board-card-meta-row").boundingBox(),
			]);
			expect(tokens && time && line).toBeTruthy();
			if (tokens && time && line) {
				expect(Math.abs(tokens.x - line.x - (line.x + line.width - (time.x + time.width)))).toBeLessThan(2);
				expect(time.y).toBeGreaterThan(line.y + line.height - 1);
			}
			const readTokens = async () =>
				Number.parseFloat((await stats.getByTestId("board-card-token-usage").textContent()) ?? "");
			const before = await readTokens();
			await expect.poll(readTokens, { timeout: 20_000 }).toBeGreaterThan(before);
			await testInfo.attach("running card", { body: await running.screenshot(), contentType: "image/png" });

			const backlog = page.locator(`[data-task-id="${backlogTaskId}"]`).filter({ visible: true }).first();
			await backlog.scrollIntoViewIfNeeded();
			const backlogId = backlog.getByTestId("board-card-task-id");
			const backlogPill = backlog.getByTestId("board-card-agent");
			await expect(backlogPill).toHaveText(`Claude Code · ${LONG_MODEL}`);
			await expect(backlog.getByTestId("board-card-token-usage")).toHaveCount(0);
			const waiting = backlog.getByTestId("board-card-second-row").getByTestId("board-card-prerequisites");
			await expect(waiting).toHaveText("Waiting on 1 of 1");
			await expectCentered(waiting, backlog.getByTestId("board-card-meta-row"));
			// The long model truncates inside the pill, and on the narrowest columns the agent name too; the id stays whole on
			// the same line.
			await expectOneLine(backlogId, backlogPill);
			await expectInside(backlogPill, backlog.getByTestId("board-card-meta-row"));
			// One line each: the id pill is as tall as the agent pill.
			await expectSameHeight(backlogId, backlogPill);
			await testInfo.attach("backlog card", { body: await backlog.screenshot(), contentType: "image/png" });
		});
	});
}
