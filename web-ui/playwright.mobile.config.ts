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
	},
});
