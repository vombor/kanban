// New project: make a directory inside a projects root, `git init -b <branch>` it, optionally commit a README, and
// add it like "Open folder" / `kanban project add` (default kit, landing off). One implementation for the browser
// (tRPC `projects.create`) and `kanban project create`. Refuses anything that isn't a new or empty directory outside
// any git repo, so it never takes over existing work: those go through Open folder.
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runGit } from "../workspace/git-utils";
import { type AddProjectResult, addProject } from "./project-add";
import {
	findEnclosingGitDirectory,
	type ProjectRoots,
	readProjectRoots,
	resolvePathInsideProjectRoots,
} from "./project-roots";

export const DEFAULT_INITIAL_BRANCH = "main";
export const FALLBACK_GIT_IDENTITY = {
	name: "Kanban (no git identity configured)",
	email: "kanban-no-git-identity@localhost",
} as const;
const INITIAL_COMMIT_MESSAGE = "Initial commit";

export interface CreateProjectInput {
	/** Absolute path of the new project directory. */
	path: string;
	/** Display name and README title (default: the directory name). */
	name?: string;
	initialBranch?: string;
	/** Commit a README.md so task worktrees have a base ref (default true). */
	initialCommit?: boolean;
	/** Resolved roots (default: config.json's `projects.roots`). */
	projectRoots?: ProjectRoots;
}

export interface CreateProjectResult {
	repoPath: string;
	name: string;
	initialBranch: string;
	/** The initial commit's sha, or null when it was turned off. */
	initialCommit: string | null;
	/** Whose identity made the initial commit: the machine's git config, or the fallback for that commit only. */
	commitIdentity: "git-config" | "fallback" | null;
	/** Things the user should know (fallback identity, no commit yet, registration notes). */
	notes: string[];
	project: AddProjectResult;
}

export class ProjectCreateError extends Error {}

const OPEN_FOLDER_HINT = 'use "Open folder" (kanban project add) to add it instead';

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function describeFsError(error: unknown, action: string): string {
	const code = errorCode(error);
	if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
		return `Permission denied: can't ${action}.`;
	}
	return `Can't ${action}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Refuses a target that exists and isn't an empty directory, or that sits in a git repo. */
async function assertNewProjectDirectory(path: string, root: string): Promise<boolean> {
	const entry = await lstat(path).catch((error: unknown) => {
		if (errorCode(error) === "ENOENT") {
			return null;
		}
		throw new ProjectCreateError(describeFsError(error, `inspect ${path}`));
	});
	if (entry && !entry.isDirectory()) {
		throw new ProjectCreateError(`${path} already exists and is not a directory.`);
	}
	const enclosingRepo = await findEnclosingGitDirectory(path, root);
	if (enclosingRepo === path) {
		throw new ProjectCreateError(`${path} is already a git repository; ${OPEN_FOLDER_HINT}.`);
	}
	if (enclosingRepo) {
		throw new ProjectCreateError(
			`${path} is inside the git repository ${enclosingRepo}; a new project can't be nested in another repo. To work on that repo, use "Open folder" (kanban project add) to add ${enclosingRepo}.`,
		);
	}
	if (entry) {
		const children = await readdir(path).catch((error: unknown) => {
			throw new ProjectCreateError(describeFsError(error, `read ${path}`));
		});
		if (children.length > 0) {
			throw new ProjectCreateError(
				`${path} already exists and is not empty. A new project needs a new or empty directory; to add existing files, ${OPEN_FOLDER_HINT}.`,
			);
		}
	}
	return entry !== null;
}

async function assertGitAvailable(cwd: string): Promise<void> {
	const version = await runGit(cwd, ["--version"]);
	if (!version.ok) {
		throw new ProjectCreateError(
			`git is not available (git --version failed: ${version.stderr || version.error}). Install git to create a project.`,
		);
	}
}

async function assertValidBranchName(cwd: string, branch: string): Promise<void> {
	const check = await runGit(cwd, ["check-ref-format", "--branch", branch]);
	if (!branch || !check.ok) {
		throw new ProjectCreateError(`"${branch}" is not a valid branch name.`);
	}
}

/** True when git has a configured identity (config or GIT_* env), never a guessed one. */
async function hasConfiguredGitIdentity(repoPath: string): Promise<boolean> {
	for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
		const ident = await runGit(repoPath, ["-c", "user.useConfigOnly=true", "var", variable]);
		if (!ident.ok) {
			return false;
		}
	}
	return true;
}

/** The directory `mkdir -p` will create first under `path`'s deepest existing ancestor (for the rollback). */
async function findFirstMissingDirectory(path: string): Promise<string | null> {
	let missing: string | null = null;
	let current = path;
	while ((await lstat(current).catch(() => null)) === null) {
		missing = current;
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return missing;
}

async function initializeRepository(
	repoPath: string,
	name: string,
	branch: string,
	initialCommit: boolean,
): Promise<Pick<CreateProjectResult, "initialCommit" | "commitIdentity" | "notes">> {
	const init = await runGit(repoPath, ["init", "-b", branch]);
	if (!init.ok) {
		throw new ProjectCreateError(`git init failed: ${init.stderr || init.error}`);
	}
	if (!initialCommit) {
		return {
			initialCommit: null,
			commitIdentity: null,
			notes: ["No initial commit: Kanban can't create task worktrees until the repo has its first commit."],
		};
	}
	try {
		await writeFile(join(repoPath, "README.md"), `# ${name}\n`, "utf8");
	} catch (error) {
		throw new ProjectCreateError(describeFsError(error, `write ${join(repoPath, "README.md")}`));
	}
	const add = await runGit(repoPath, ["add", "README.md"]);
	if (!add.ok) {
		throw new ProjectCreateError(`git add failed: ${add.stderr || add.error}`);
	}
	const identityConfigured = await hasConfiguredGitIdentity(repoPath);
	// Scoped to this one commit: Kanban never writes git config.
	const identityArgs = identityConfigured
		? []
		: ["-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`, "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`];
	const commit = await runGit(repoPath, [...identityArgs, "commit", "-q", "-m", INITIAL_COMMIT_MESSAGE]);
	if (!commit.ok) {
		throw new ProjectCreateError(`The initial commit failed: ${commit.stderr || commit.error}`);
	}
	const head = await runGit(repoPath, ["rev-parse", "HEAD"]);
	return {
		initialCommit: head.ok ? head.stdout : null,
		commitIdentity: identityConfigured ? "git-config" : "fallback",
		notes: identityConfigured
			? []
			: [
					`No git identity is configured (user.name / user.email), so the initial commit was made as "${FALLBACK_GIT_IDENTITY.name} <${FALLBACK_GIT_IDENTITY.email}>" for that commit only. Kanban did not change any git config; set your identity with git config --global user.name / user.email.`,
				],
	};
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
	const projectRoots = input.projectRoots ?? (await readProjectRoots());
	const target = await resolvePathInsideProjectRoots(input.path, projectRoots);
	if (!target.ok) {
		throw new ProjectCreateError(target.error);
	}
	const { path: repoPath, root } = target;
	const name = input.name?.trim() || basename(repoPath);
	if (/[\r\n]/.test(name)) {
		throw new ProjectCreateError("The project name must be one line.");
	}
	const initialBranch = input.initialBranch?.trim() || DEFAULT_INITIAL_BRANCH;
	const initialCommit = input.initialCommit !== false;

	const existed = await assertNewProjectDirectory(repoPath, root);
	await assertGitAvailable(root);
	await assertValidBranchName(root, initialBranch);

	const firstCreated = existed ? null : await findFirstMissingDirectory(repoPath);
	try {
		await mkdir(repoPath, { recursive: true });
	} catch (error) {
		throw new ProjectCreateError(describeFsError(error, `create ${repoPath}`));
	}
	let repository: Awaited<ReturnType<typeof initializeRepository>>;
	try {
		repository = await initializeRepository(repoPath, name, initialBranch, initialCommit);
	} catch (error) {
		// Leave nothing half-made: the directory as it was (absent or empty).
		if (firstCreated) {
			await rm(firstCreated, { recursive: true, force: true }).catch(() => {});
		} else {
			await rm(join(repoPath, ".git"), { recursive: true, force: true }).catch(() => {});
			await rm(join(repoPath, "README.md"), { force: true }).catch(() => {});
		}
		throw error;
	}

	const project = await addProject({
		repoPath,
		name: name !== basename(repoPath) ? name : undefined,
		allowUnbornHead: !initialCommit,
		projectRoots,
	});
	return {
		repoPath: project.repoPath,
		name,
		initialBranch,
		...repository,
		notes: [...repository.notes, ...project.warnings],
		project,
	};
}
