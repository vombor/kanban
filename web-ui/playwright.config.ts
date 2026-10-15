import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	// Mobile specs start their own dev instance: playwright.mobile.config.ts.
	testIgnore: "mobile/**",
	timeout: 30_000,
	use: {
		headless: true,
	},
});
