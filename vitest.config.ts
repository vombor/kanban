import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// `packages/**` excluded: those workspaces have their own vitest
		// configs and runtime shapes (e.g. Electron) and are run explicitly by
		// CI. New workspaces under `packages/` MUST get matching install/test
		// steps in .github/workflows/test.yml or they fall out of CI coverage.
		exclude: [
			"apps/**",
			"packages/**",
			"web-ui/**",
			"third_party/**",
			"**/node_modules/**",
			"**/dist/**",
			".worktrees/**",
		],
		// Clears KANBAN_HOME / KANBAN_WORKTREES so a developer's real home never leaks into tests.
		setupFiles: ["test/utilities/vitest-setup.ts"],
		testTimeout: 15_000,
	},
});
