// The projects roots (`projects.roots` in config.json, schema in src/config/pipeline-config.ts): every project Kanban
// creates (New project), clones or opens (Open folder, `kanban project add`) must be strictly inside one of them. In
// the container that is `/projects`, the projects volume; /root holds config, the Kanban home and task worktrees.
// Worktree creation never goes through this check, and a task worktree (anything under the Kanban home's worktree
// roots) is refused here even inside a root: it is never a project, whoever asks. Already registered projects
// outside a root keep working (doctor warns). This module is the one check; the browser only pre-validates names.
import { existsSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { readPipelineConfig } from "../config/pipeline-config";
import { hasParentDirectorySegment, validateProjectDirectoryName } from "../core/project-paths";
import { getTaskWorktreeSearchRootPaths } from "../state/kanban-home";
import { isPathWithinRoot } from "../workspace/path-sandbox";
import { resolveProjectInputPath } from "./project-path";

/** The built-in default's first source when `projects.roots` is unset (path-list separated, like PATH). */
export const PROJECTS_ROOTS_ENV = "KANBAN_PROJECTS_ROOTS";
const CONTAINER_PROJECTS_ROOT = "/projects";
const CONTAINER_MARKER_FILES = ["/run/.containerenv", "/.dockerenv"] as const;

export type ProjectRootsSource = "config" | "env" | "container" | "home";

export interface ProjectRoots {
	/** The real paths of the roots that exist, in configured order. The first is the default parent. */
	roots: string[];
	/** The roots as configured (absolute), including ones that don't exist. */
	configured: string[];
	/** Configured roots that don't exist; nothing can be created under them. */
	missing: string[];
	source: ProjectRootsSource;
}

export interface ProjectRootsDefaultsInput {
	env?: NodeJS.ProcessEnv;
	isContainer?: boolean;
	homeDir?: string;
}

export function isRunningInContainer(): boolean {
	return CONTAINER_MARKER_FILES.some((file) => existsSync(file));
}

/** The roots when `projects.roots` is unset: $KANBAN_PROJECTS_ROOTS, else /projects in a container, else home. */
export function getDefaultProjectRoots(input: ProjectRootsDefaultsInput = {}): {
	roots: string[];
	source: Exclude<ProjectRootsSource, "config">;
} {
	const fromEnv = (input.env ?? process.env)[PROJECTS_ROOTS_ENV]
		?.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (fromEnv && fromEnv.length > 0) {
		return { roots: fromEnv, source: "env" };
	}
	if (input.isContainer ?? isRunningInContainer()) {
		return { roots: [CONTAINER_PROJECTS_ROOT], source: "container" };
	}
	return { roots: [input.homeDir ?? homedir()], source: "home" };
}

/** Resolves the configured (or default) roots to real paths. `configuredRoots` null means "use the default". */
export async function resolveProjectRoots(
	configuredRoots: string[] | null,
	defaults: ProjectRootsDefaultsInput = {},
): Promise<ProjectRoots> {
	const { roots: rawRoots, source } =
		configuredRoots === null
			? getDefaultProjectRoots(defaults)
			: { roots: configuredRoots, source: "config" as const };
	const configured = rawRoots.map((root) => resolveProjectInputPath(root, "/"));
	const roots: string[] = [];
	const missing: string[] = [];
	for (const root of configured) {
		try {
			const real = await realpath(root);
			if (!roots.includes(real)) {
				roots.push(real);
			}
		} catch {
			missing.push(root);
		}
	}
	return { roots, configured, missing, source };
}

/** The projects roots from config.json (`projects.roots`), or the default. */
export async function readProjectRoots(configPath?: string): Promise<ProjectRoots> {
	const { config } = await readPipelineConfig(configPath);
	return await resolveProjectRoots(config.projects.roots);
}

export function describeProjectRoots(projectRoots: ProjectRoots): string {
	return (projectRoots.roots.length > 0 ? projectRoots.roots : projectRoots.configured).join(", ");
}

export type ProjectRootCheck = { ok: true; path: string; root: string } | { ok: false; path: string; error: string };

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

/** The task worktree root (current or legacy, as a real path) that `path` lies in, or null. */
export async function findTaskWorktreesRoot(path: string): Promise<string | null> {
	for (const root of getTaskWorktreeSearchRootPaths()) {
		const real = await realpath(root).catch(() => resolve(root));
		if (isPathWithinRoot(real, path)) {
			return real;
		}
	}
	return null;
}

/**
 * Resolves `rawPath` the way the OS will (realpath of its deepest existing ancestor, so a symlink anywhere in the
 * existing part is followed) and accepts it only strictly inside a root. `..` segments are refused outright: they
 * would be resolved lexically here but physically by the OS after a symlink.
 */
export async function resolvePathInsideProjectRoots(
	rawPath: string,
	projectRoots: ProjectRoots,
): Promise<ProjectRootCheck> {
	const trimmed = rawPath.trim();
	const rootsText = describeProjectRoots(projectRoots);
	if (!isAbsolute(trimmed)) {
		return { ok: false, path: trimmed, error: `"${trimmed}" is not an absolute path.` };
	}
	if (hasParentDirectorySegment(trimmed)) {
		return {
			ok: false,
			path: trimmed,
			error: `"${trimmed}" contains "..": give the project's directory directly, inside ${rootsText}.`,
		};
	}
	if (projectRoots.roots.length === 0) {
		return {
			ok: false,
			path: trimmed,
			error: `No projects root exists (${rootsText}, setting projects.roots): create it first.`,
		};
	}
	const lexical = resolve(trimmed);
	let existing = lexical;
	const missingSegments: string[] = [];
	for (;;) {
		try {
			await lstat(existing);
			break;
		} catch (error) {
			const code = errorCode(error);
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				return {
					ok: false,
					path: lexical,
					error:
						code === "EACCES" || code === "EPERM"
							? `Permission denied: can't inspect ${existing}.`
							: `Can't inspect ${existing}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		const parent = dirname(existing);
		if (parent === existing) {
			break;
		}
		missingSegments.unshift(basename(existing));
		existing = parent;
	}
	let realExisting: string;
	try {
		realExisting = await realpath(existing);
	} catch {
		return { ok: false, path: lexical, error: `${existing} is a broken symlink.` };
	}
	const target = missingSegments.length > 0 ? join(realExisting, ...missingSegments) : realExisting;
	const resolvedNote = target === lexical ? "" : ` (${lexical} resolves to ${target})`;
	if (projectRoots.roots.includes(target)) {
		return {
			ok: false,
			path: target,
			error: `${target} is the projects root itself${resolvedNote}; a project must be a directory inside it.`,
		};
	}
	const worktreesRoot = await findTaskWorktreesRoot(target);
	if (worktreesRoot) {
		return {
			ok: false,
			path: target,
			error: `${target} is a Kanban task worktree (under ${worktreesRoot})${resolvedNote}, never a project; add the project's main checkout instead.`,
		};
	}
	const root = projectRoots.roots.find((candidate) => isPathWithinRoot(candidate, target));
	if (!root) {
		return {
			ok: false,
			path: target,
			error: `${target} is outside the projects root ${rootsText}${resolvedNote}. Projects must be inside it (setting projects.roots).`,
		};
	}
	return { ok: true, path: target, root };
}

export class ProjectRootError extends Error {}

/** `resolvePathInsideProjectRoots` that throws a `ProjectRootError` with its message. */
export async function assertPathInsideProjectRoots(rawPath: string, projectRoots: ProjectRoots): Promise<string> {
	const check = await resolvePathInsideProjectRoots(rawPath, projectRoots);
	if (!check.ok) {
		throw new ProjectRootError(check.error);
	}
	return check.path;
}

export interface ProjectDirectoryNameCheck {
	ok: boolean;
	/** The absolute directory, when the root and name are valid. */
	path: string | null;
	exists: boolean;
	isGitRepository: boolean;
	isEmpty: boolean;
	error?: string;
}

async function hasGitEntry(directory: string): Promise<boolean> {
	return (await lstat(join(directory, ".git")).catch(() => null)) !== null;
}

/**
 * The add-project dialog's advisory typeahead: does `<root>/<name>` exist, is it a git repo, is it empty? It answers
 * only for one name directly under an allowed root and never lists anything; creating re-checks everything.
 */
export async function checkProjectDirectoryName(
	input: { root: string; name: string },
	projectRoots: ProjectRoots,
): Promise<ProjectDirectoryNameCheck> {
	const refused = (error: string): ProjectDirectoryNameCheck => ({
		ok: false,
		path: null,
		exists: false,
		isGitRepository: false,
		isEmpty: false,
		error,
	});
	if (!projectRoots.roots.includes(input.root)) {
		return refused(`${input.root} is not a projects root (${describeProjectRoots(projectRoots)}).`);
	}
	const nameError = validateProjectDirectoryName(input.name);
	if (nameError) {
		return refused(nameError);
	}
	const check = await resolvePathInsideProjectRoots(join(input.root, input.name), projectRoots);
	if (!check.ok) {
		return refused(check.error);
	}
	const entry = await lstat(check.path).catch(() => null);
	if (!entry) {
		return { ok: true, path: check.path, exists: false, isGitRepository: false, isEmpty: false };
	}
	if (!entry.isDirectory()) {
		return { ok: true, path: check.path, exists: true, isGitRepository: false, isEmpty: false };
	}
	const isGitRepository = await hasGitEntry(check.path);
	const isEmpty = (await readdir(check.path).catch(() => ["?"])).length === 0;
	return { ok: true, path: check.path, exists: true, isGitRepository, isEmpty };
}

/** The nearest directory from `directory` up to `root` (both inclusive) that has a `.git` entry, or null. */
export async function findEnclosingGitDirectory(directory: string, root: string): Promise<string | null> {
	let current = directory;
	for (;;) {
		if (await hasGitEntry(current)) {
			return current;
		}
		if (current === root || !isPathWithinRoot(root, current)) {
			return null;
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}
