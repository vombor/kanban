// "Does this Review card have work to submit?": its worktree exists and has uncommitted changes or commits its
// base doesn't have. A Review card with neither (a planning loop, a question to the user) is not submitted.
// The snapshot stage (P4-2) replaces this with the snapshot's own diff against the base.
import type { RuntimeBoardCard } from "../core/api-contract";
import { probeGitWorkspaceState } from "../workspace/git-sync";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

export async function probeTaskHasWork(workspacePath: string, card: RuntimeBoardCard): Promise<boolean> {
	try {
		const pathInfo = await getTaskWorkspacePathInfo({ cwd: workspacePath, taskId: card.id, baseRef: card.baseRef });
		if (!pathInfo.exists) {
			return false;
		}
		const probe = await probeGitWorkspaceState(pathInfo.path);
		if (probe.changedFiles > 0) {
			return true;
		}
		const ahead = await runGit(pathInfo.path, ["rev-list", "--count", `${card.baseRef}..HEAD`]);
		return ahead.ok && Number(ahead.stdout) > 0;
	} catch {
		return false;
	}
}
