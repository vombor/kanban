import { writeFile } from "node:fs/promises";
import { devices } from "@playwright/test";
import { expect, test } from "../shared-chrome";
import { startDevInstance } from "./dev-instance";

const { defaultBrowserType: _browserType, ...desktopChrome } = devices["Desktop Chrome"];
for (const profile of ["phone", "desktop"] as const) {
	test.describe(profile, () => {
		if (profile === "desktop") test.use({ ...desktopChrome, viewport: { width: 1400, height: 900 } });
		test("large diff fixture bounds eager work and retains navigation, expansion and comments", async ({
			page,
		}, testInfo) => {
			const instance = await startDevInstance({
				fakeCommands: { claude: "#!/bin/sh\necho 'fake Claude'\n" },
				globalConfig: { selectedAgentId: "claude", watchdog: { mode: "off" } },
			});
			try {
				page.on("pageerror", (error) => console.error(error.message));
				page.on("response", async (response) => {
					if (response.status() >= 400) console.error(response.url(), await response.text());
				});
				page.on("console", (message) => {
					if (message.type() === "error") console.error(message.text());
				});
				await page.route("**/diff-performance-fixture", (route) =>
					route.fulfill({
						contentType: "text/html",
						body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
</script><script type="module">
import { mountDiffPerformanceFixture } from '/tests/mobile/diff-performance-fixture.tsx';
mountDiffPerformanceFixture(document.getElementById('root'));
</script></body></html>`,
					}),
				);
				await page.goto(`${instance.baseUrl}/diff-performance-fixture`, { waitUntil: "domcontentloaded" });
				await expect(page.getByRole("button", { name: "Mount fixture" })).toBeVisible({ timeout: 30_000 });
				await page.getByRole("button", { name: "Mount fixture" }).click();
				await expect(page.locator(".kb-diff-row-added").first()).toBeVisible();
				await page.evaluate(async () => {
					for (let index = 0; index < 8; index++) await new Promise(requestAnimationFrame);
				});
				const mount = await page.evaluate(() => ({
					rows: document.querySelectorAll(".kb-diff-row").length,
					renderMs: performance.getEntriesByName("diff-mount").map((entry) => entry.duration),
					activationMs: performance.getEntriesByName("diff-update").map((entry) => entry.duration),
				}));
				await page.evaluate(() => performance.clearMeasures());
				await page.getByRole("button", { name: "Parent tick" }).click();
				const update = await page.evaluate(() =>
					performance.getEntriesByName("diff-update").map((entry) => entry.duration),
				);
				const reportPath = testInfo.outputPath("diff-performance.json");
				await writeFile(reportPath, JSON.stringify({ profile, mount, update }, null, 2));
				await testInfo.attach("diff-performance.json", {
					path: reportPath,
					contentType: "application/json",
				});
				console.log(JSON.stringify({ profile, mount, update }));
				if (process.env.DIFF_BASELINE === "1") return;
				expect(mount.rows).toBeLessThan(100);
				await page.locator(".kb-file-tree-row").filter({ hasText: "file-099.ts" }).click();
				const last = page.locator("section").filter({ has: page.locator('[title="src/file-099.ts"]') });
				await expect(last.locator(".kb-diff-row-added")).toBeVisible();
				await last.locator(".kb-diff-row-added").click();
				await last.getByPlaceholder("Add a comment...").fill("Keep this edit");
				await page.getByRole("button", { name: /^Add/ }).click();
				await expect(page.getByLabel("Sent comments")).toContainText("src/file-099.ts:1201");
				await expect(page.getByLabel("Sent comments")).toContainText("Keep this edit");
				await last.getByRole("button", { name: "↓ 20 lines" }).first().click();
				await expect(last.locator(".kb-diff-row")).toHaveCount(28);
				await page.locator(".kb-file-tree-row").filter({ hasText: "file-000.ts" }).click();
				await page.locator(".kb-file-tree-row").filter({ hasText: "file-099.ts" }).click();
				await expect(last.locator(".kb-diff-row")).toHaveCount(28);
				await last
					.getByRole("button", { name: /Show all/ })
					.first()
					.click();
				await expect(last.locator(".kb-diff-row")).toHaveCount(1205);
				await expect(last.locator(".kb-diff-row").first()).toContainText("const value0 = 0");
				await page.getByRole("button", { name: "Toggle split" }).click();
				await expect(last.locator(".kb-diff-split-grid-row").first()).toBeVisible();
			} finally {
				await instance.stop();
			}
		});
	});
}
