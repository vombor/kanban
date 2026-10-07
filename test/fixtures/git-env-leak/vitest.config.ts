import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../../vitest.config";

// Run by test/runtime/git-env-isolation.test.ts with GIT_DIR / GIT_INDEX_FILE pointing at a fake repo: the root
// config's global setup and setup files, and only this directory's fixture.
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["test/fixtures/git-env-leak/*.fixture.ts"],
		},
	}),
);
