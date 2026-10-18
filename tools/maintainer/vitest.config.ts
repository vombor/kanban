import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";
export default defineConfig({
	test: {
		include: ["tools/maintainer/test/**/*.test.ts"],
		environment: "node",
		globalSetup: ["test/utilities/vitest-global-setup.ts"],
		setupFiles: ["test/utilities/vitest-setup.ts", "test/utilities/isolate-agent-config.ts"],
		testTimeout: 15_000,
	},
});
