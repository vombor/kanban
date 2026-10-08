import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentId } from "../../../src/core/api-contract";
import { COPILOT_TOKEN_ENV_NAMES, prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { buildTerminalEnvironment } from "../../../src/terminal/session-manager";

// The container's GH_TOKEN is the user's PAT (docs/fork/github-auth.md). Copilot would take it over its own login,
// so its launches drop every token variable it reads; all other agents keep the PAT for gh, git and npm.
describe("GitHub token env in agent launches", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kanban-github-token-env-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("COPILOT_HOME", join(home, ".copilot"));
		vi.stubEnv("GH_TOKEN", "pat-from-the-container");
		vi.stubEnv("GITHUB_TOKEN", "pat-fallback");
		vi.stubEnv("COPILOT_GITHUB_TOKEN", "copilot-token");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	async function launchEnv(agentId: RuntimeAgentId): Promise<Record<string, string>> {
		const cwd = join(home, `worktree-${agentId}`);
		mkdirSync(cwd, { recursive: true });
		const launch = await prepareAgentLaunch({
			taskId: `task-${agentId}`,
			agentId,
			binary: agentId,
			args: [],
			cwd,
			prompt: "Build it",
			workspaceId: "workspace-1",
		});
		return buildTerminalEnvironment(undefined, launch.env);
	}

	it("removes Copilot's token variables from a Copilot launch", async () => {
		const env = await launchEnv("copilot");
		for (const name of COPILOT_TOKEN_ENV_NAMES) {
			expect(name in env).toBe(false);
		}
		expect(Object.values(env)).not.toContain("undefined");
	});

	it.each(["claude", "codex", "cline"] as const)("keeps GH_TOKEN in a %s launch", async (agentId) => {
		const env = await launchEnv(agentId);
		expect(env.GH_TOKEN).toBe("pat-from-the-container");
		expect(env.GITHUB_TOKEN).toBe("pat-fallback");
	});
});
