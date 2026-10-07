import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Claude Code and Codex key folder trust by git repository root, and a linked worktree uses its MAIN
// repository's root (the directory holding the git common dir). So trusting /projects/app covers every task
// worktree of it, wherever the worktrees live. Outside git, the directory itself is the key.
// (Claude Code 2.1.291, verified on throwaway repos and worktrees; Codex resolves the same way in
// codex-rs `resolve_root_git_project_for_trust`.)
export interface WorkspaceTrustRoot {
	path: string;
	isGitRepository: boolean;
}

export interface AgentWorkspaceTrustResult {
	changed: boolean;
	trustRootPath: string;
	error?: string;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function findGitTopLevel(directory: string): Promise<string | null> {
	for (let current = resolve(directory); ; current = dirname(current)) {
		if (await pathExists(join(current, ".git"))) {
			return current;
		}
		if (current === dirname(current)) {
			return null;
		}
	}
}

// Symlinks resolved: the agent sees its cwd as process.cwd(), which is the real path.
async function toRealPath(path: string): Promise<string> {
	return await realpath(path).catch(() => resolve(path));
}

export async function resolveWorkspaceTrustRoot(directory: string): Promise<WorkspaceTrustRoot> {
	const realDirectory = await toRealPath(directory);
	const topLevel = await findGitTopLevel(realDirectory);
	if (!topLevel) {
		return { path: realDirectory, isGitRepository: false };
	}
	const dotGitPath = join(topLevel, ".git");
	try {
		if ((await stat(dotGitPath)).isDirectory()) {
			return { path: topLevel, isGitRepository: true };
		}
		const gitDirMatch = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGitPath, "utf8"));
		const gitDirValue = gitDirMatch?.[1]?.trim();
		if (!gitDirValue) {
			return { path: topLevel, isGitRepository: true };
		}
		const gitDir = resolve(topLevel, gitDirValue);
		const commonDirFile = join(gitDir, "commondir");
		const commonDir = (await pathExists(commonDirFile))
			? resolve(gitDir, (await readFile(commonDirFile, "utf8")).trim())
			: gitDir;
		return {
			path: basename(commonDir) === ".git" ? await toRealPath(dirname(commonDir)) : topLevel,
			isGitRepository: true,
		};
	} catch {
		return { path: topLevel, isGitRepository: true };
	}
}

// The root Kanban may pre-trust for `directory`: only a git repository's main root, and never the user's
// home directory or a filesystem root (a home or sidebar agent can run in either).
export async function resolvePreTrustRoot(directory: string): Promise<{ trustRootPath: string; error?: string }> {
	const root = await resolveWorkspaceTrustRoot(directory);
	if (!root.isGitRepository) {
		return { trustRootPath: root.path, error: `${root.path} is not inside a git repository; not pre-trusted` };
	}
	if (root.path === (await toRealPath(homedir())) || root.path === dirname(root.path)) {
		return {
			trustRootPath: root.path,
			error: `${root.path} is the home directory or a filesystem root; not pre-trusted`,
		};
	}
	return { trustRootPath: root.path };
}

const trustConfigFileQueues = new Map<string, Promise<unknown>>();

// Runs `task` after every earlier task for the same config file has settled, so in-process read-check-write
// sequences on one agent config file never interleave (other processes are handled by each writer).
export async function withTrustConfigFileLock<T>(configFilePath: string, task: () => Promise<T>): Promise<T> {
	const key = await realpath(configFilePath).catch(() => resolve(configFilePath));
	const previous = trustConfigFileQueues.get(key) ?? Promise.resolve();
	const run = previous.then(task, task);
	const settled = run.catch(() => undefined);
	trustConfigFileQueues.set(key, settled);
	try {
		return await run;
	} finally {
		if (trustConfigFileQueues.get(key) === settled) {
			trustConfigFileQueues.delete(key);
		}
	}
}
