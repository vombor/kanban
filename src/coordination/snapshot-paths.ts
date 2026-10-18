import { coordinationPathSchema } from "../core/coordination-hints";
import { readTaskSnapshot } from "../pipeline/snapshots";
import { executionTaskIdSchema } from "../trpc/knowledge-execution-contract";
import { runGit } from "../workspace/git-utils";

/** Reads only existing immutable snapshots. Never captures dirty work, changes a ref or touches an agent's index. */
export async function readCoordinationSnapshot(repoPath: string, taskId: string, baseRef: string) {
	executionTaskIdSchema.parse(taskId);
	const snapshot = await readTaskSnapshot(repoPath, taskId);
	const base = await runGit(repoPath, ["rev-parse", "--verify", "--end-of-options", `${baseRef || "HEAD"}^{commit}`]);
	const baseCommit = base.ok && /^[a-f0-9]{40,64}$/u.test(base.stdout) ? base.stdout : null;
	if (!snapshot || !baseCommit) return { snapshot, baseCommit, observedPaths: [], pathsTruncated: true };
	const fork = await runGit(repoPath, ["merge-base", baseCommit, snapshot]);
	if (!fork.ok) return { snapshot, baseCommit, observedPaths: [], pathsTruncated: true };
	const diff = await runGit(repoPath, ["diff", "--name-only", "--no-renames", "-z", fork.stdout, snapshot, "--"], {
		trimStdout: false,
	});
	if (!diff.ok) return { snapshot, baseCommit, observedPaths: [], pathsTruncated: true };
	const paths = diff.stdout.split("\0").filter(Boolean),
		safe = paths.filter((p) => coordinationPathSchema.safeParse(p).success);
	return {
		snapshot,
		baseCommit,
		observedPaths: safe.slice(0, 100),
		pathsTruncated: paths.length > 100 || safe.length !== paths.length,
	};
}
