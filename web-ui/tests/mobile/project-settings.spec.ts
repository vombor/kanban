import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { devices, type Page } from "@playwright/test";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const FAKE_AGENT = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }
process.stdout.write("ISOLATED TEST AGENT\\r\\n");
process.stdin.resume();
`;
const { defaultBrowserType: _defaultBrowserType, ...desktop } = devices["Desktop Chrome"];

async function showSidebar(page: Page, isPhone: boolean) {
	const actions = page.getByRole("button", { name: "Project actions" });
	if (isPhone && !(await actions.isVisible())) await page.getByRole("button", { name: "Toggle sidebar" }).click();
	await expect(actions).toBeVisible();
}

for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
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
		test("creates with optional secrets, edits scripts and rotates/removes secrets through the project definition", async ({
			page,
		}) => {
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(instance.baseUrl);
			await showSidebar(page, profile === "phone");
			await page.getByRole("button", { name: "Add project", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await expect(dialog.getByRole("tab")).toHaveText(["New project", "Clone from URL", "Open folder"]);
			await dialog.getByRole("tab", { name: "New project" }).click();
			await dialog.getByRole("textbox", { name: "Project name", exact: true }).fill("Project settings test");
			await dialog.getByRole("button", { name: "Next", exact: true }).click();
			await expect(dialog).toContainText("2 of 2 · Secrets");
			await expect(dialog.getByRole("button", { name: "Add script" })).toHaveCount(0);
			await dialog.getByRole("button", { name: "Add secret" }).click();
			await dialog.getByLabel("Secret 1 name", { exact: true }).fill("TEST_KEY");
			await dialog.getByLabel("Secret 1 value", { exact: true }).fill("first-private-value");
			await dialog.getByRole("button", { name: "Create Project" }).click();
			await expect(dialog).toHaveCount(0);
			await showSidebar(page, profile === "phone");
			await expect(page.getByRole("combobox", { name: "Project", exact: true })).toContainText(
				"Project settings test",
			);
			const edit = async () => {
				await page.getByRole("button", { name: "Project actions" }).click();
				await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
				await expect(dialog).toContainText("Edit Project");
				await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
			};
			await edit();
			await expect(dialog).toContainText("TEST_KEY");
			await expect(dialog).toContainText("Configured");
			await expect(dialog.getByLabel("Secret 1 value", { exact: true })).toHaveCount(0);
			await dialog.getByRole("button", { name: "Add script" }).click();
			await dialog.getByLabel("Script 1 command", { exact: true }).fill("npm run dev");
			await dialog.getByRole("button", { name: "Add secret" }).click();
			await dialog.getByLabel("Secret 1 name", { exact: true }).fill("TEST_KEY");
			await dialog.getByLabel("Secret 1 value", { exact: true }).fill("rotated-private-value");
			await dialog.getByRole("button", { name: "Save", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			const data = join(instance.rootDir, "kanban-home", "data");
			const vaults = await Promise.all(
				(await readdir(data)).map(
					async (workspace) =>
						await readFile(join(data, workspace, "project-secrets.json"), "utf8").catch(() => ""),
				),
			);
			expect(vaults.join("\n")).toContain("TEST_KEY");
			expect(vaults.join("\n")).not.toContain("first-private-value");
			expect(vaults.join("\n")).not.toContain("rotated-private-value");
			await edit();
			await expect(dialog.getByLabel("Script 1 command", { exact: true })).toHaveValue("npm run dev");
			await dialog.getByRole("button", { name: "Remove secret TEST_KEY", exact: true }).click();
			await dialog.getByRole("button", { name: "Save", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			expect(errors).toEqual([]);
		});
	});
}
