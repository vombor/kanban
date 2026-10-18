import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createGitProcessEnv } from "../../../src/core/git-process-env";

it("verifies the packaged read-only Python bridge with offline GitHub fixtures", async () => {
	const result = await promisify(execFile)("python3", ["test/runtime/maintenance/test_github_app_bridge.py"], {
		env: createGitProcessEnv(),
		timeout: 15_000,
	});
	expect(result.stderr).toContain("OK");
});
