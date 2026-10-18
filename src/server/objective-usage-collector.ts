// Reuse the canonical CLI reader. Read only objective members' canonical worktrees, including retained/pruned ids.
import { resolve } from "node:path";
import { loadPriceTable, type PriceTable } from "../kits/team/bench/prices";
import type { ObjectiveStore } from "../objectives/objective-store";
import { priceObjectiveObservation } from "../objectives/objective-usage";
import { listWorkspaceIndexEntries } from "../state/workspace-state";
import type { AgentTokenUsageReader, AgentTokenUsageSources } from "../terminal/agent-token-usage";
import { getTaskWorktreeCandidatePaths } from "../workspace/task-worktree";
import { readAgentTokenUsageSources } from "./task-token-usage";

export function createObjectiveUsageCollector(options: {
	store: ObjectiveStore;
	reader: AgentTokenUsageReader;
	workspacePath: (workspaceId: string) => string | null;
	registeredProjects?: typeof listWorkspaceIndexEntries;
	sources?: () => Promise<AgentTokenUsageSources>;
	prices?: () => Promise<PriceTable>;
	worktrees?: (repoPath: string, taskId: string) => string[];
	now?: () => number;
}) {
	return async (workspaceId: string): Promise<void> => {
		const repo =
			options.workspacePath(workspaceId) ??
			(await (options.registeredProjects ?? listWorkspaceIndexEntries)()).find(
				(project) => project.workspaceId === workspaceId,
			)?.repoPath;
		if (!repo) throw new Error("Objective usage project is unavailable.");
		const { objectives } = await options.store.read(workspaceId);
		if (!objectives.length) return;
		const paths = new Map<string, string[]>();
		for (const objective of objectives)
			for (const task of objective.tasks) {
				const own = (options.worktrees ?? getTaskWorktreeCandidatePaths)(repo, task.taskId).filter(
					(path) => resolve(path) !== resolve(repo),
				);
				paths.set(task.taskId, own);
			}
		const sources = await (options.sources ?? readAgentTokenUsageSources)();
		const usage = await options.reader.read([...new Set([...paths.values()].flat())], sources, {
			observations: true,
		});
		const prices = await (options.prices ?? loadPriceTable)();
		const observedAt = new Date((options.now ?? Date.now)()).toISOString();
		for (const objective of objectives) {
			const observations = objective.tasks.flatMap((task) =>
				(paths.get(task.taskId) ?? []).flatMap((path) =>
					(usage.get(path)?.observations ?? []).map((observation) =>
						priceObjectiveObservation({ objective, taskId: task.taskId, observation, prices, observedAt }),
					),
				),
			);
			await options.store.recordUsage(workspaceId, objective.id, observations);
		}
	};
}
