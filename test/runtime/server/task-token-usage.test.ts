import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createTaskTokenUsageLoader } from "../../../src/server/task-token-usage";
import type {
	AgentTokenUsageReader,
	AgentTokenUsageSources,
	TokenCounts,
} from "../../../src/terminal/agent-token-usage";

const SOURCES: AgentTokenUsageSources = {
	claudeProjectsPath: "/tmp/claude/projects",
	clineSessionsPath: "/tmp/cline/sessions",
	codexSessionsPath: "/tmp/codex/sessions",
	copilotSessionStatePath: "/tmp/copilot/session-state",
};

function card(id: string): RuntimeBoardCard {
	return { id, title: id, prompt: id, startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
}

function board(columns: Partial<Record<"backlog" | "in_progress" | "review" | "trash", string[]>>): RuntimeBoardData {
	return {
		columns: (["backlog", "in_progress", "review", "trash"] as const).map((id) => ({
			id,
			title: id,
			cards: (columns[id] ?? []).map(card),
		})),
		dependencies: [],
	};
}

function summary(taskId: string, workspacePath: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
	};
}

const counts = (output: number): TokenCounts => ({ input: 1, output, cacheRead: 0, cacheWrite: 0 });

describe("createTaskTokenUsageLoader", () => {
	it("measures every card past Backlog in its session's worktree, else the worktree Kanban would create", async () => {
		const read = vi.fn<AgentTokenUsageReader["read"]>(
			async () =>
				new Map([
					["/wt/aaaaa/repo-live", counts(10)],
					["/home/wt/bbbbb/repo", counts(20)],
				]),
		);
		const load = createTaskTokenUsageLoader({
			reader: { read },
			loadBoard: async () =>
				board({ backlog: ["zzzzz"], in_progress: ["aaaaa"], review: ["bbbbb"], trash: ["ccccc"] }),
			readSources: async () => SOURCES,
			worktreesRootPath: () => "/home/wt",
		});

		const response = await load({ workspaceId: "ws", workspacePath: "/projects/repo" }, [
			summary("aaaaa", "/wt/aaaaa/repo-live"),
		]);

		expect(read).toHaveBeenCalledWith(["/wt/aaaaa/repo-live", "/home/wt/bbbbb/repo", "/home/wt/ccccc/repo"], SOURCES);
		expect(response.usage).toEqual([
			{ taskId: "aaaaa", ...counts(10) },
			{ taskId: "bbbbb", ...counts(20) },
		]);
	});

	it("never measures a card that ran in the main checkout, and reads nothing for a Backlog-only board", async () => {
		const read = vi.fn<AgentTokenUsageReader["read"]>(async () => new Map());
		const load = createTaskTokenUsageLoader({
			reader: { read },
			loadBoard: async () => board({ in_progress: ["aaaaa"] }),
			readSources: async () => SOURCES,
			worktreesRootPath: () => "/home/wt",
		});

		expect(
			await load({ workspaceId: "ws", workspacePath: "/projects/repo" }, [summary("aaaaa", "/projects/repo/")]),
		).toEqual({ usage: [] });
		expect(read).not.toHaveBeenCalled();
	});
});
