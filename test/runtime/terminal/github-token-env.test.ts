import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentId } from "../../../src/core/api-contract";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { buildTerminalEnvironment } from "../../../src/terminal/session-manager";

// The container's GH_TOKEN is the user's PAT and COPILOT_GITHUB_TOKEN is Copilot's own token
// (docs/fork/github-auth.md). Every agent launch keeps both; Copilot picks COPILOT_GITHUB_TOKEN over the PAT itself.
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

	it.each(["copilot", "claude", "codex", "cline"] as const)("keeps every token in a %s launch", async (agentId) => {
		const env = await launchEnv(agentId);
		expect(env.COPILOT_GITHUB_TOKEN).toBe("copilot-token");
		expect(env.GH_TOKEN).toBe("pat-from-the-container");
		expect(env.GITHUB_TOKEN).toBe("pat-fallback");
		expect(Object.values(env)).not.toContain("undefined");
	});

	it("doesn't add any token to a Copilot launch's own env", async () => {
		const cwd = join(home, "worktree-copilot-own");
		mkdirSync(cwd, { recursive: true });
		const launch = await prepareAgentLaunch({
			taskId: "task-copilot-own",
			agentId: "copilot",
			binary: "copilot",
			args: [],
			cwd,
			prompt: "Build it",
			workspaceId: "workspace-1",
		});
		for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
			expect(name in launch.env).toBe(false);
		}
	});

	it("still drops an undefined source value instead of passing the string on", () => {
		const env = buildTerminalEnvironment({ SOME_VAR: undefined });
		expect("SOME_VAR" in env).toBe(false);
	});
});
