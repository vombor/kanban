import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { unstartedTaskEligibility } from "./unstarted-task-eligibility";

/** A missing current summary alone cannot prove no earlier attempt; include history, pipeline evidence and worktrees. */
export async function canAdoptTaskReferences(input: {
	workspaceId: string;
	taskId: string;
	state: Pick<RuntimeWorkspaceStateResponse, "board" | "sessions">;
	repoPath: string;
	live: Record<string, RuntimeTaskSessionSummary>;
	pipelineTaskIds: string[];
	homePath?: string;
}): Promise<boolean> {
	const eligibility = await unstartedTaskEligibility({
		workspaceId: input.workspaceId,
		board: input.state.board,
		sessions: { ...input.state.sessions, ...input.live },
		pipelineTaskIds: input.pipelineTaskIds,
		home: input.homePath,
	});
	if (!eligibility.unstarted.has(input.taskId)) return false;
	const card = input.state.board.columns
		.flatMap((column) => column.cards)
		.find((candidate) => candidate.id === input.taskId);
	if (!card) return false;
	return !(await getTaskWorkspacePathInfo({ cwd: input.repoPath, taskId: input.taskId, baseRef: card.baseRef }))
		.exists;
}
