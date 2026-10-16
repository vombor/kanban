import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { devices } from "@playwright/test";
import { expect, test } from "../shared-chrome";
import { type DevInstance, startDevInstance } from "./dev-instance";

const { defaultBrowserType: _browserType, ...desktop } = devices["Desktop Chrome"];
for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") test.use({ ...desktop, viewport: { width: 1400, height: 900 } });
		let instance: DevInstance;
		let fake: Server;
		let endpoint: string;
		const requestedPaths: string[] = [];
		test.beforeAll(async () => {
			fake = createServer((request, response) => {
				requestedPaths.push(request.url ?? "");
				response.setHeader("Content-Type", "application/json");
				if (request.url === "/") {
					response.end(
						JSON.stringify({
							authenticated: request.headers.authorization === "Bearer browser-test-key",
							versions: { self: "5.4.0" },
						}),
					);
				} else {
					response.end(
						JSON.stringify({
							paths: {
								"/search/": {},
								"/vault/{filename}": {
									get: {
										responses: { "200": { content: { "application/vnd.olrapi.document-map+json": {} } } },
									},
								},
							},
							components: {
								schemas: { NoteJson: { properties: { links: {}, backlinks: {}, unresolvedLinks: {} } } },
							},
						}),
					);
				}
			});
			await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
			const address = fake.address();
			if (!address || typeof address === "string") throw new Error("Missing test API address");
			endpoint = `http://127.0.0.1:${address.port}`;
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
			fake?.closeAllConnections();
			if (fake) await new Promise<void>((resolve) => fake.close(() => resolve()));
		});
		test("configures an optional system connector, tests without saving, preserves masked keys and removes them explicitly", async ({
			page,
		}) => {
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			await page.goto(instance.baseUrl);
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			const dialog = page.getByRole("dialog");
			if (profile === "phone")
				await dialog.getByRole("combobox", { name: "Settings section" }).selectOption("knowledge");
			else await dialog.getByRole("button", { name: "Knowledge", exact: true }).click();
			const section = dialog.getByRole("region", { name: "Obsidian knowledge connector" });
			await expect(section.getByRole("button", { name: "Save connector" })).toHaveCount(0);
			const save = dialog.getByRole("button", { name: "Save", exact: true });
			await expect(save).toBeDisabled();
			await expect(section.getByRole("button", { name: "Test connection" })).toBeEnabled();
			const file = join(instance.rootDir, "kanban-home", "secrets", "obsidian-connector.json");
			await section.getByLabel("Obsidian API key", { exact: true }).fill("discard-this-draft");
			await expect(save).toBeEnabled();
			await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			if (profile === "phone")
				await dialog.getByRole("combobox", { name: "Settings section" }).selectOption("knowledge");
			else await dialog.getByRole("button", { name: "Knowledge", exact: true }).click();
			await expect(section.getByLabel("Obsidian API key", { exact: true })).toHaveValue("");
			await expect(section.getByRole("checkbox", { name: "Enable Obsidian connector" })).not.toBeChecked();
			await section.getByLabel("Obsidian REST API endpoint", { exact: true }).fill(endpoint);
			await section.getByLabel("Obsidian API key", { exact: true }).fill("browser-test-key");
			await expect(save).toBeEnabled();
			await section.getByRole("button", { name: "Test connection" }).click();
			await expect(section).toContainText("Native graph: available");
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			expect(requestedPaths).toEqual(["/", "/openapi.json"]);
			await section.getByRole("checkbox", { name: "Enable Obsidian connector" }).check();
			await section.getByLabel("Obsidian REST API endpoint", { exact: true }).fill("not-a-url");
			await save.click();
			await expect(dialog).toContainText("Could not save the Obsidian connector");
			await expect(section.getByLabel("Obsidian API key", { exact: true })).toHaveValue("browser-test-key");
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
			await section.getByLabel("Obsidian REST API endpoint", { exact: true }).fill(endpoint);
			await save.click();
			await expect(dialog).toHaveCount(0);
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			const stored = JSON.parse(await readFile(file, "utf8")) as {
				apiKey: string | null;
				settings: { enabled: boolean };
			};
			expect(stored.apiKey).toBe("browser-test-key");
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			if (profile === "phone")
				await dialog.getByRole("combobox", { name: "Settings section" }).selectOption("knowledge");
			else await dialog.getByRole("button", { name: "Knowledge", exact: true }).click();
			await expect(section).toContainText("stored; leave empty to keep");
			await expect(section.getByLabel("Obsidian API key", { exact: true })).toHaveValue("");
			await section.getByRole("checkbox", { name: "Enable Obsidian connector" }).uncheck();
			await section.getByRole("checkbox", { name: "Remove stored API key", exact: false }).check();
			await expect(save).toBeEnabled();
			await save.click();
			await expect(dialog).toHaveCount(0);
			const removed = JSON.parse(await readFile(file, "utf8")) as typeof stored;
			expect(removed.apiKey).toBeNull();
			expect(removed.settings.enabled).toBe(false);
		});
	});
}
