import { isAbsolute, relative, sep } from "node:path";

import { resolveProjectInputPath } from "../projects/project-path";
import { listWorkspaceIndexEntries, type RuntimeWorkspaceIndexEntry } from "../state/workspace-state";

export interface WorkspaceTarget {
	workspaceId: string;
	/** The registered repo path, or null for a workspace id that isn't registered on this home. */
	repoPath: string | null;
}

function isInside(path: string, root: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function findByPath(entries: RuntimeWorkspaceIndexEntry[], path: string): RuntimeWorkspaceIndexEntry | null {
	const matches = entries.filter((entry) => isInside(path, entry.repoPath));
	// The deepest repo wins (a worktree or nested repo inside another registered one).
	return matches.sort((left, right) => right.repoPath.length - left.repoPath.length)[0] ?? null;
}

/**
 * The workspace a `--project`/`--workspace` value names: a registered workspace id, else a path inside a registered
 * repo. Without a value, the registered repo containing the current directory. `allowUnregistered` accepts an
 * unknown value as a workspace id (for read-only commands that show what such a workspace would get).
 */
export async function resolveWorkspaceTarget(
	value: string | undefined,
	options: { allowUnregistered: boolean; cwd?: string },
): Promise<WorkspaceTarget> {
	const cwd = options.cwd ?? process.cwd();
	const entries = await listWorkspaceIndexEntries();
	const trimmed = value?.trim();
	if (trimmed) {
		const byId = entries.find((entry) => entry.workspaceId === trimmed);
		if (byId) {
			return { workspaceId: byId.workspaceId, repoPath: byId.repoPath };
		}
		const byPath = findByPath(entries, resolveProjectInputPath(trimmed, cwd));
		if (byPath) {
			return { workspaceId: byPath.workspaceId, repoPath: byPath.repoPath };
		}
		if (options.allowUnregistered) {
			return { workspaceId: trimmed, repoPath: null };
		}
		throw new Error(`"${trimmed}" is not a registered workspace id or a path inside a registered project.`);
	}
	const byCwd = findByPath(entries, cwd);
	if (!byCwd) {
		throw new Error(`${cwd} is not inside a registered project; pass --project <workspace id or path>.`);
	}
	return { workspaceId: byCwd.workspaceId, repoPath: byCwd.repoPath };
}
