import { stat } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../../src/config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { findOrchestratorWait, type OrchestratorWaitSessions } from "../../../src/server/orchestrator-wait";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import { loadWorkspaceContext } from "../../../src/state/workspace-state";
import { describeBrokenGitRepository, hasGitRepository } from "../../../src/workspace/repo-health";
import { createRepoWithWorktree } from "../../utilities/git-repo";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

function summary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/projects/alpha",
		pid: 4242,
		startedAt: 1_000,
		updatedAt: 5_000,
		stateChangedAt: 5_000,
		lastOutputAt: 5_000,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: 5_000,
		latestHookActivity: {
			activityText: "Waiting for approval: Bash: git push",
			toolName: "Bash",
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "PermissionRequest",
			notificationType: null,
			source: "claude",
		},
		modelId: null,
		reasoningEffort: null,
		...overrides,
	};
}

function sessions(
	summaries: RuntimeTaskSessionSummary[],
	options: { live?: (taskId: string) => boolean; answeredAt?: (taskId: string) => number | null } = {},
): OrchestratorWaitSessions {
	return {
		listSummaries: () => summaries,
		hasLiveProcess: options.live ?? (() => true),
		getViewerInputSubmittedAt: options.answeredAt ?? (() => null),
	};
}

describe("findOrchestratorWait", () => {
	const home = createHomeAgentSessionId("alpha", "claude");

	it("reads only the workspace's own sidebar sessions with a process", () => {
		const waiting = summary(home);
		expect(findOrchestratorWait(sessions([waiting]), "alpha")).toEqual({
			kind: "approval",
			since: 5_000,
			text: "Bash: git push",
			taskId: home,
			agentId: "claude",
		});
		// A card's session and another workspace's sidebar are not this project's orchestrator.
		expect(
			findOrchestratorWait(
				sessions([summary("card-1"), summary(createHomeAgentSessionId("beta", "claude"))]),
				"alpha",
			),
		).toBe(null);
		// A summary hydrated after a restart (no process) waits for nothing.
		expect(findOrchestratorWait(sessions([waiting], { live: () => false }), "alpha")).toBe(null);
		expect(findOrchestratorWait(null, "alpha")).toBe(null);
	});

	it("clears once the user pressed Enter in the sidebar after the request", () => {
		expect(findOrchestratorWait(sessions([summary(home)], { answeredAt: () => 6_000 }), "alpha")).toBe(null);
		expect(findOrchestratorWait(sessions([summary(home)], { answeredAt: () => 4_000 }), "alpha")).not.toBe(null);
	});

	it("names the oldest wait when two sidebar agents wait", () => {
		const codex = createHomeAgentSessionId("alpha", "codex");
		const found = findOrchestratorWait(
			sessions([summary(home, { lastHookAt: 9_000 }), summary(codex, { agentId: "codex", lastHookAt: 7_000 })]),
			"alpha",
		);
		expect(found).toMatchObject({ taskId: codex, since: 7_000 });
	});
});

describe("project summaries: orchestratorWait", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("carries kind and start for every project, never the question (the list reaches agent sessions)", async () => {
		await withTemporaryKanbanHome(async () => {
			const repo = createRepoWithWorktree();
			cleanups.push(repo.cleanup);
			const outside = createTempDir();
			cleanups.push(outside.cleanup);
			const { workspaceId } = await loadWorkspaceContext(repo.repoPath);
			const registry = await createWorkspaceRegistry({
				cwd: outside.path,
				loadGlobalRuntimeConfig,
				loadRuntimeConfig,
				hasGitRepository,
				describeBrokenGitRepository,
				pathIsDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
				logError: () => {},
			});
			const before = await registry.buildProjectsPayload(workspaceId);
			expect(before.projects[0]?.orchestratorWait).toBe(null);

			const manager = await registry.ensureTerminalManagerForWorkspace(workspaceId, repo.repoPath);
			const sidebar = createHomeAgentSessionId(workspaceId, "claude");
			manager.hydrateFromRecord({ [sidebar]: summary(sidebar) });
			vi.spyOn(manager, "hasLiveProcess").mockReturnValue(true);

			const after = await registry.buildProjectsPayload(workspaceId);
			expect(after.projects[0]?.orchestratorWait).toEqual({ kind: "approval", since: 5_000 });
			expect(JSON.stringify(after)).not.toContain("git push");
		});
	});
});
