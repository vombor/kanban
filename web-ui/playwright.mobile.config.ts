import { defineConfig, devices } from "@playwright/test";

// Mobile (touch) e2e tests. Each spec starts its own throwaway Kanban
// (tests/mobile/dev-instance.ts), so there is no shared webServer here.
export default defineConfig({
	testDir: "./tests/mobile",
	timeout: 120_000,
	workers: 1,
	use: {
		...devices["Pixel 7"],
		headless: true,
		screenshot: "only-on-failure",
		// Lets a machine whose cached browser doesn't match this Playwright use it anyway.
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
			: {},
	},
});
