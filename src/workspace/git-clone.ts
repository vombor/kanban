import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { describeProjectRoots, type ProjectRoots, resolvePathInsideProjectRoots } from "../projects/project-roots.js";
import { runGit } from "./git-utils.js";

export interface GitCloneResult {
	ok: boolean;
	clonedPath: string;
	error?: string;
}

/**
 * Derive a repository name from a Git URL.
 *
 * Handles HTTPS URLs (e.g. `https://github.com/user/repo.git`),
 * SSH URLs (e.g. `git@github.com:user/repo.git`), and bare names.
 * Strips a trailing `.git` suffix if present.
 */
export function deriveRepoNameFromUrl(gitUrl: string): string | null {
	const trimmed = gitUrl.trim().replace(/\/+$/, "");
	if (!trimmed) {
		return null;
	}

	// Handle SSH-style URLs: git@host:user/repo.git
	const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
	const pathPart = sshMatch?.[1] ?? trimmed;

	// Take the last path segment.
	const lastSegment = basename(pathPart);
	if (!lastSegment) {
		return null;
	}

	// Strip trailing .git
	const name = lastSegment.endsWith(".git") ? lastSegment.slice(0, -4) : lastSegment;
	return name || null;
}

/**
 * Clone a Git repository into a new (or empty) directory strictly inside a projects root
 * (src/projects/project-roots.ts: realpath of the deepest existing ancestor, no symlink or `..` escapes).
 *
 * @param gitUrl - The Git repository URL to clone.
 * @param projectRoots - The allowed roots; the first one is the default parent.
 * @param destinationPath - Optional absolute destination. If omitted, the clone is placed at
 *   `<first root>/<repo-name>`. An existing destination must be an empty directory.
 */
export async function cloneGitRepository(
	gitUrl: string,
	projectRoots: ProjectRoots,
	destinationPath?: string,
): Promise<GitCloneResult> {
	const repoName = deriveRepoNameFromUrl(gitUrl);
	if (!repoName && !destinationPath) {
		return {
			ok: false,
			clonedPath: "",
			error: "Could not derive repository name from URL and no destination path was provided.",
		};
	}
	const defaultParent = projectRoots.roots[0];
	if (!destinationPath && !defaultParent) {
		return {
			ok: false,
			clonedPath: "",
			error: `No projects root exists (${describeProjectRoots(projectRoots)}, setting projects.roots): create it first.`,
		};
	}

	// At this point either destinationPath or (repoName and a root) is set (guarded above).
	const rawDestination = destinationPath ?? join(defaultParent as string, repoName as string);
	const check = await resolvePathInsideProjectRoots(rawDestination, projectRoots);
	if (!check.ok) {
		return { ok: false, clonedPath: check.path, error: check.error };
	}
	const clonePath = check.path;

	const existing = await lstat(clonePath).catch(() => null);
	if (existing) {
		const isEmptyDirectory = existing.isDirectory() && (await readdir(clonePath).catch(() => ["?"])).length === 0;
		if (!isEmptyDirectory) {
			return {
				ok: false,
				clonedPath: clonePath,
				error: `Destination already exists and is not an empty directory: "${clonePath}".`,
			};
		}
	}

	// Ensure the parent directory exists.
	const parentDir = dirname(clonePath);
	try {
		await mkdir(parentDir, { recursive: true });
	} catch (error) {
		return {
			ok: false,
			clonedPath: clonePath,
			error: `Failed to create parent directory "${parentDir}": ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// Run `git clone <url> <destination>`.
	// The cwd for the git process should be the parent directory of the destination.
	const result = await runGit(parentDir, ["clone", "--", gitUrl, clonePath]);
	if (!result.ok) {
		return {
			ok: false,
			clonedPath: clonePath,
			error: result.error ?? `Git clone failed: ${result.stderr || result.output}`,
		};
	}

	return {
		ok: true,
		clonedPath: clonePath,
	};
}
