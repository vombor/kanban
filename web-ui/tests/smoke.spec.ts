import type { Page } from "@playwright/test";
import { type DevInstance, startDevInstance } from "./mobile/dev-instance";
import { expect, test } from "./shared-chrome";

let instance: DevInstance;
test.beforeAll(async () => {
	instance = await startDevInstance({
		fakeCommands: {
			claude: `#!/usr/bin/env node
if(process.argv.includes("--version")){console.log("fake 1.0");process.exit(0);}
process.stdin.resume();
`,
		},
		globalConfig: { home: 1, selectedAgentId: "claude" },
	});
});
test.afterAll(async () => {
	await instance?.stop();
});
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
});

async function createTaskFromBacklog(page: Page, title: string) {
	const backlogColumn = page.locator('[data-column-id="backlog"]').first();
	await backlogColumn.getByRole("button", { name: "Create task" }).click();
	const prompt = page.getByPlaceholder("Describe the task...");
	await prompt.fill(title);
	await page.getByRole("dialog", { name: "New task" }).getByRole("button", { name: "Create", exact: true }).click();
}

async function openTaskFromBoard(page: Page, title: string) {
	const card = page.locator("[data-task-id]").filter({ hasText: title }).first();
	await expect(card).toBeVisible();
	await card.click();
}

test("renders kanban top bar and columns", async ({ page }) => {
	await page.goto(instance.baseUrl);
	await expect(page).toHaveTitle(/Kanban/);
	await expect(page.getByRole("combobox", { name: "Project" })).toBeVisible();
	await expect(page.getByText("Kanban Agent", { exact: true })).toBeVisible();
	await expect(page.getByText("Backlog", { exact: true })).toBeVisible();
	await expect(page.getByText("In Progress", { exact: true })).toBeVisible();
	await expect(page.getByText("Review", { exact: true })).toBeVisible();
	await expect(page.getByText("Done", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Create task" })).toBeVisible();
});

test("creating and opening a backlog task shows the inline editor", async ({ page }) => {
	await page.goto(instance.baseUrl);
	const taskTitle = `smoke-${Date.now()}`;
	await createTaskFromBacklog(page, taskTitle);
	await openTaskFromBoard(page, taskTitle);
	await expect(page.getByPlaceholder("Describe the task...")).toHaveValue(taskTitle);
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
});

test("escape key closes the backlog inline editor", async ({ page }) => {
	await page.goto(instance.baseUrl);
	const taskTitle = `escape-${Date.now()}`;
	await createTaskFromBacklog(page, taskTitle);
	await openTaskFromBoard(page, taskTitle);
	await expect(page.getByPlaceholder("Describe the task...")).toHaveValue(taskTitle);
	await page.keyboard.press("Escape");
	await expect(page.getByPlaceholder("Describe the task...")).toHaveCount(0);
	await expect(page.getByText("Backlog", { exact: true })).toBeVisible();
	await expect(page.locator("[data-task-id]").filter({ hasText: taskTitle }).first()).toBeVisible();
});

test("settings button opens runtime settings dialog", async ({ page }) => {
	await page.goto(instance.baseUrl);
	await page.getByTestId("open-settings-button").click();
	await expect(page.getByRole("dialog").getByText("Global Settings", { exact: true })).toBeVisible();
});
