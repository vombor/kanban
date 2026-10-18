import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname } from "node:path";
import { createGitProcessEnv, isGitUserEnvName } from "../core/git-process-env";
import { SNAPSHOT_GIT_IDENTITY } from "../pipeline/snapshots";
import type { IntegrationManifest } from "../trpc/integration-contract";
import { runGit } from "../workspace/git-utils";

export const integrationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** All object writes stay in a server-owned disposable bare repository, never the project's index/objects/refs. */
export async function buildIntegrationCandidate(
	repoPath: string,
	candidatePath: string,
	manifest: IntegrationManifest,
	onCreated: () => void = () => {},
) {
	await mkdir(dirname(candidatePath), { recursive: true, mode: 0o700 });
	await mkdir(candidatePath, { mode: 0o700 });
	onCreated();
	const env = {
		...Object.fromEntries(Object.entries(createGitProcessEnv()).filter(([name]) => !isGitUserEnvName(name))),
		GIT_CONFIG_GLOBAL: devNull,
		GIT_CONFIG_SYSTEM: devNull,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		...SNAPSHOT_GIT_IDENTITY,
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	};
	const git = async (args: string[]) =>
		runGit(
			candidatePath,
			[
				"-c",
				`core.hooksPath=${devNull}`,
				"-c",
				"core.fsmonitor=false",
				"-c",
				`core.attributesFile=${devNull}`,
				...args,
			],
			{ env },
		);
	if (!(await git(["-c", "init.templateDir=", "init", "--bare", "."])).ok)
		throw new Error("Candidate repository unavailable");
	if (
		!(
			await git([
				"-c",
				"protocol.file.allow=always",
				"fetch",
				"--no-tags",
				"--no-write-fetch-head",
				"--no-recurse-submodules",
				"--",
				repoPath,
				manifest.baseCommit,
				...manifest.members.map((member) => member.snapshot),
			])
		).ok
	)
		throw new Error("Exact candidate objects unavailable");
	let current = manifest.baseCommit;
	for (const member of manifest.members) {
		const merged = await git(["merge-tree", "--write-tree", "--no-messages", current, member.snapshot]);
		if (merged.exitCode === 1) return { candidateCommit: null, candidateTree: null, conflictTaskId: member.taskId };
		const tree = merged.stdout.split("\n")[0];
		if (!merged.ok || !tree || !/^[a-f0-9]{40,64}$/u.test(tree)) throw new Error("Candidate merge unavailable");
		const commit = await git([
			"commit-tree",
			tree,
			"-p",
			current,
			"-p",
			member.snapshot,
			"-m",
			`Kanban speculative integration ${manifest.fingerprint}`,
		]);
		if (!commit.ok || !/^[a-f0-9]{40,64}$/u.test(commit.stdout)) throw new Error("Candidate commit unavailable");
		current = commit.stdout;
	}
	const tree = await git(["rev-parse", "--verify", `${current}^{tree}`]);
	if (!tree.ok) throw new Error("Candidate tree unavailable");
	return { candidateCommit: current, candidateTree: tree.stdout, conflictTaskId: null };
}
