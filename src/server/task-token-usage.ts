// The board cards' token counts (tRPC workspace.getTaskTokenUsage): every card past Backlog, measured in its worktree
// (the session's workspacePath, else the worktree Kanban would create; never the main checkout) by src/terminal/agent-token-usage.ts.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeTaskSessionSummary, RuntimeTaskTokenUsageResponse } from "../core/api-contract";
import { getClineDataDirPath, getCodexSessionsPath, getTaskWorktreesRootPath } from "../state/kanban-home";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { getCopilotHomePath } from "../terminal/agent-session-adapters";
import {
	type AgentTokenUsageReader,
	type AgentTokenUsageSources,
	createAgentTokenUsageReader,
} from "../terminal/agent-token-usage";
import { getClineSessionsPath } from "../terminal/cline-session-files";
import { buildTaskWorktreeDisplayPath } from "../workspace/task-worktree-path";

export interface TaskTokenUsageScope {
	workspaceId: string;
	workspacePath: string;
}

export interface TaskTokenUsageDependencies {
	reader?: AgentTokenUsageReader;
	loadBoard?: typeof loadWorkspaceBoardById;
	readSources?: () => Promise<AgentTokenUsageSources>;
	worktreesRootPath?: () => string;
}

export type LoadTaskTokenUsage = (
	scope: TaskTokenUsageScope,
	summaries: readonly RuntimeTaskSessionSummary[],
) => Promise<RuntimeTaskTokenUsageResponse>;

/** Where the agent CLIs keep their session files, from the core settings (agent data dirs) and the env. */
export async function readAgentTokenUsageSources(): Promise<AgentTokenUsageSources> {
	const { config } = await readPipelineConfig();
	const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return {
		claudeProjectsPath: join(claudeConfigDir, "projects"),
		clineSessionsPath: getClineSessionsPath(getClineDataDirPath(config.agents.cline.dataDir)),
		codexSessionsPath: getCodexSessionsPath(config.agents.codex.home),
		copilotSessionStatePath: join(getCopilotHomePath(), "session-state"),
	};
}

export function createTaskTokenUsageLoader(deps: TaskTokenUsageDependencies = {}): LoadTaskTokenUsage {
	const reader = deps.reader ?? createAgentTokenUsageReader();
	const loadBoard = deps.loadBoard ?? loadWorkspaceBoardById;
	const readSources = deps.readSources ?? readAgentTokenUsageSources;
	const worktreesRootPath = deps.worktreesRootPath ?? getTaskWorktreesRootPath;
	return async (scope, summaries) => {
		const board = await loadBoard(scope.workspaceId);
		const summaryByTaskId = new Map(summaries.map((summary) => [summary.taskId, summary]));
		const mainCheckout = resolve(scope.workspacePath);
		const worktreeByTaskId = new Map<string, string>();
		for (const column of board.columns) {
			if (column.id === "backlog") {
				continue;
			}
			for (const card of column.cards) {
				const worktree =
					summaryByTaskId.get(card.id)?.workspacePath ??
					buildTaskWorktreeDisplayPath(card.id, scope.workspacePath, worktreesRootPath());
				// A card run in the main checkout shares it with the orchestrator and every other such card: not its own.
				if (resolve(worktree) !== mainCheckout) {
					worktreeByTaskId.set(card.id, worktree);
				}
			}
		}
		if (worktreeByTaskId.size === 0) {
			return { usage: [] };
		}
		const counts = await reader.read([...new Set(worktreeByTaskId.values())], await readSources());
		const usage: RuntimeTaskTokenUsageResponse["usage"] = [];
		for (const [taskId, worktree] of worktreeByTaskId) {
			const taskCounts = counts.get(worktree);
			if (taskCounts) {
				usage.push({ taskId, ...taskCounts });
			}
		}
		return { usage };
	};
}
