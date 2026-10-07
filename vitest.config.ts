import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		exclude: ["apps/**", "web-ui/**", "third_party/**", "**/node_modules/**", "**/dist/**", ".worktrees/**"],
		// Removes the git variables a hook exports (GIT_DIR, GIT_INDEX_FILE, ...) before any worker starts.
		globalSetup: ["test/utilities/vitest-global-setup.ts"],
		// Clears KANBAN_HOME / KANBAN_WORKTREES and git hook variables so a developer's real home and repo never
		// leak into tests, and points the Claude/Codex config files at a missing dir so pre-trust never edits the real ones.
		setupFiles: ["test/utilities/vitest-setup.ts", "test/utilities/isolate-agent-config.ts"],
		testTimeout: 15_000,
	},
});
