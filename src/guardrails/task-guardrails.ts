// The guardrails of one task card's agent session: the commands it must never run and the directories it may write
// (`guardrails.*` and `workspaces.<id>.guardrails` in config.json, src/config/pipeline-config.ts). Resolved once per
// launch by the runtime and handed to the agent adapter, which applies what its CLI can enforce
// (src/terminal/agent-guardrails.ts). The orchestrator gets no card guardrails: the home-agent sidebar session (and
// the watchdog's start of it) resolves to null in resolveTaskGuardrails. Under project isolation `enforce` it gets
// resolveOrchestratorGuardrails instead (isolation plus the plan-approval rail, writes anywhere in its own project),
// and cards get the same isolation on top of their own guardrails (src/isolation/isolation-paths.ts).
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import type { RuntimeTaskAutoReviewMode } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import type { SessionIsolation } from "../isolation/isolation-paths";
import { getGitStdout } from "../workspace/git-utils";
import { readSymlinkedIgnoredPaths } from "../workspace/task-worktree";
import {
	allowOwnBranchPush,
	BUILT_IN_DENY_COMMANDS,
	type DeniedCommandRule,
	GITHUB_ISSUE_DENY_COMMANDS,
	parseDeniedCommandPatterns,
} from "./command-patterns";

export interface TaskGuardrails {
	/** A task card's guardrails, or the orchestrator's (isolation only, resolveOrchestratorGuardrails). */
	role: "card" | "orchestrator";
	/** The card's worktree (the agent's cwd); the project checkout for the orchestrator. */
	worktreePath: string;
	/** The project's main checkout. */
	projectPath: string;
	/**
	 * The main checkout and the project's other worktrees at launch (`git worktree list`), when they are outside the
	 * card's worktree: for agents that can only deny writes to named dirs, not allow them (Copilot, Claude Code).
	 */
	protectedDirs: string[];
	/** Keep writes inside the worktree and the dirs below where the agent's CLI can enforce it. */
	confineWrites: boolean;
	// Where the card may write besides its worktree (listGuardrailWritableRoots). The agent's own data dirs are added
	// by its adapter.
	/** The repo's git dir: commits, rebases and fetches of a linked worktree write there. */
	gitCommonDir: string | null;
	tempDirs: string[];
	/** The targets of ignored paths Kanban symlinked into the worktree (a shared node_modules). */
	linkedDirs: string[];
	/** `guardrails.extraWritableDirs` plus the workspace's. */
	extraWritableDirs: string[];
	/** Branches no card may rewrite: `guardrails.sharedBranches`, the workspace's default base and the card's base. */
	sharedBranches: string[];
	deniedCommands: DeniedCommandRule[];
	/**
	 * The card was launched with the PR git action and `guardrails.prCardPush` is `own-branch`: where Kanban's command
	 * matcher guards the shell, it may push its own branch (listMatcherDeniedCommands); elsewhere push stays denied.
	 */
	ownBranchPush: boolean;
	/** Project isolation (`enforce`): the other projects and the machine-wide config; null when isolation is off. */
	isolation: SessionIsolation | null;
}

/** The prompt line that steers an agent to Kanban's GitHub App for issue writes. */
export const GITHUB_ISSUE_PROMPT_LINE =
	"- GitHub issues and comments: file, comment, edit and close them with `kanban github issue create|comment|edit|close --repo <owner/name> ... --body-file <file>`, which posts as Kanban's GitHub App and names this project; never with `gh issue create|comment|edit|close` or `gh api` writes. Reading issues with gh is fine.";

/** The configured patterns plus the built-in rails: plan approval and GitHub issue writes (command-patterns.ts). */
export function withBuiltInDenies(patterns: readonly string[]): string[] {
	return [...new Set([...patterns, ...BUILT_IN_DENY_COMMANDS])];
}

export interface ResolveTaskGuardrailsInput {
	config: PipelineConfig;
	taskId: string;
	workspaceId: string;
	worktreePath: string;
	projectPath: string;
	baseRef?: string | null;
	/** The card's git action (`autoReviewMode`) at launch; `pr` may allow pushing its own branch. */
	gitAction?: RuntimeTaskAutoReviewMode | null;
	/** The launch's project isolation (resolveSessionIsolation), or null. */
	isolation?: SessionIsolation | null;
}

function toBranchName(ref: string | null | undefined): string | null {
	const name = ref
		?.trim()
		.replace(/^refs\/heads\//u, "")
		.replace(/^refs\/remotes\//u, "")
		.replace(/^origin\//u, "");
	return name ? name : null;
}

function addUnique(list: string[], value: string | null): void {
	if (value && !list.includes(value)) {
		list.push(value);
	}
}

async function realpathOrSelf(path: string): Promise<string> {
	return await realpath(path).catch(() => path);
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(process.env.HOME ?? "", path.slice(1)) : path;
}

/** True when `path` is `root` or inside it. */
export function isPathInside(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function listOtherWorktrees(worktreePath: string, projectPath: string): Promise<string[]> {
	const output = await getGitStdout(["worktree", "list", "--porcelain"], worktreePath).catch(() => "");
	const dirs: string[] = [];
	for (const path of [
		projectPath,
		...output
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length).trim()),
	]) {
		const real = await realpathOrSelf(path);
		if (!isPathInside(real, worktreePath) && !isPathInside(worktreePath, real)) {
			addUnique(dirs, real);
		}
	}
	return dirs;
}

async function listSymlinkTargets(worktreePath: string): Promise<string[]> {
	const targets: string[] = [];
	for (const relativePath of await readSymlinkedIgnoredPaths(worktreePath)) {
		const path = join(worktreePath, relativePath);
		const stats = await lstat(path).catch(() => null);
		if (stats?.isSymbolicLink()) {
			addUnique(targets, await realpathOrSelf(path));
		}
	}
	return targets;
}

/** The temp dirs every agent may write. */
export function getGuardrailTempDirs(): string[] {
	const dirs: string[] = [];
	addUnique(dirs, tmpdir());
	if (process.platform !== "win32") {
		addUnique(dirs, "/tmp");
		addUnique(dirs, "/var/tmp");
	}
	return dirs;
}

async function readGitCommonDir(cwd: string): Promise<string | null> {
	const gitCommonDir = await getGitStdout(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)
		.then((output) => output.trim())
		.catch(() => "");
	return gitCommonDir ? await realpathOrSelf(gitCommonDir) : null;
}

/**
 * The orchestrator's guardrails under project isolation: the isolation denies plus the built-in rails, writes
 * anywhere in its own project (it reviews, lands and fixes its cards' worktrees). Null without isolation.
 */
export async function resolveOrchestratorGuardrails(input: {
	projectPath: string;
	isolation: SessionIsolation | null;
}): Promise<TaskGuardrails | null> {
	if (!input.isolation) {
		return null;
	}
	const projectPath = await realpathOrSelf(input.projectPath);
	return {
		role: "orchestrator",
		worktreePath: projectPath,
		projectPath,
		protectedDirs: [],
		confineWrites: false,
		gitCommonDir: await readGitCommonDir(projectPath),
		tempDirs: getGuardrailTempDirs(),
		linkedDirs: [],
		extraWritableDirs: [],
		sharedBranches: [],
		deniedCommands: parseDeniedCommandPatterns(BUILT_IN_DENY_COMMANDS, []),
		ownBranchPush: false,
		isolation: input.isolation,
	};
}

/**
 * A card session's guardrails, or null: the orchestrator's sessions, or guardrails off for the workspace and no
 * isolation. Guardrails off with isolation on keeps only the isolation (no command denies, writes not confined).
 */
export async function resolveTaskGuardrails(input: ResolveTaskGuardrailsInput): Promise<TaskGuardrails | null> {
	if (isHomeAgentSessionId(input.taskId)) {
		return null;
	}
	const settings = input.config.guardrails;
	const workspace = getWorkspacePipelineSettings(input.config, input.workspaceId);
	const isolation = input.isolation ?? null;
	const worktreePath = await realpathOrSelf(input.worktreePath);
	const projectPath = await realpathOrSelf(input.projectPath);
	if (!(workspace.guardrails.enabled ?? settings.enabled)) {
		return isolation
			? {
					role: "card",
					worktreePath,
					projectPath,
					protectedDirs: [],
					confineWrites: false,
					gitCommonDir: await readGitCommonDir(worktreePath),
					tempDirs: getGuardrailTempDirs(),
					linkedDirs: [],
					extraWritableDirs: [],
					sharedBranches: [],
					deniedCommands: [],
					ownBranchPush: false,
					isolation,
				}
			: null;
	}

	const sharedBranches: string[] = [];
	for (const branch of settings.sharedBranches) {
		addUnique(sharedBranches, toBranchName(branch));
	}
	addUnique(sharedBranches, toBranchName(workspace.defaultBaseRef));
	addUnique(sharedBranches, toBranchName(input.baseRef));

	const gitCommonDir = await readGitCommonDir(worktreePath);
	const extraWritableDirs: string[] = [];
	for (const dir of [...settings.extraWritableDirs, ...workspace.guardrails.extraWritableDirs]) {
		addUnique(extraWritableDirs, resolve(expandHome(dir)));
	}

	return {
		role: "card",
		worktreePath,
		projectPath,
		protectedDirs: await listOtherWorktrees(worktreePath, projectPath),
		confineWrites: settings.confineWrites,
		gitCommonDir,
		tempDirs: getGuardrailTempDirs(),
		linkedDirs: await listSymlinkTargets(worktreePath),
		extraWritableDirs,
		sharedBranches,
		deniedCommands: parseDeniedCommandPatterns(
			withBuiltInDenies([...settings.denyCommands, ...workspace.guardrails.extraDenyCommands]),
			sharedBranches,
		),
		ownBranchPush: input.gitAction === "pr" && settings.prCardPush === "own-branch",
		isolation,
	};
}

/**
 * The rules for agents whose guard runs Kanban's own command matcher (Claude Code's and Cline's PreToolUse hooks):
 * a PR card's plain `git push` deny becomes `git push {shared-push}`. CLI-native deny lists (Codex, Copilot) can't
 * tell a card's own branch from a shared one, so they keep `deniedCommands` as is.
 */
export function listMatcherDeniedCommands(guardrails: TaskGuardrails): DeniedCommandRule[] {
	return guardrails.ownBranchPush
		? allowOwnBranchPush(guardrails.deniedCommands, guardrails.sharedBranches)
		: guardrails.deniedCommands;
}

/** Every directory the card may write: its worktree first. */
export function listGuardrailWritableRoots(guardrails: TaskGuardrails): string[] {
	const roots = [guardrails.worktreePath];
	for (const dir of [
		guardrails.gitCommonDir,
		...guardrails.tempDirs,
		...guardrails.linkedDirs,
		...guardrails.extraWritableDirs,
	]) {
		addUnique(roots, dir);
	}
	return roots;
}

/**
 * The guardrails as one short paragraph for the launch prompt, for agents whose CLI can't enforce some of them.
 * `unenforced` names what the CLI does not block; the note says so, because a prompt line is the weaker guard.
 */
export function buildGuardrailPromptNote(
	guardrails: TaskGuardrails,
	unenforced: readonly string[],
	rules: readonly DeniedCommandRule[] = guardrails.deniedCommands,
): string {
	const shared = guardrails.sharedBranches.join(", ");
	const patterns = rules.map((rule) => {
		if (rule.sharedPush) {
			return "git push to a shared branch or without naming the target branch (pushing your own branch, named explicitly, is fine)";
		}
		if (rule.sharedDestination) {
			return `${rule.pattern.replace(/\s*\{shared-dest\}$/u, "")} into a shared branch (a refspec <src>:<shared branch>)`;
		}
		if (rule.issuesApiWrite) {
			return "gh api calls that write an issue or issue comment";
		}
		return rule.pattern.replaceAll("{shared}", "<shared branch>");
	});
	const lines = [
		"Kanban guardrails for this card:",
		guardrails.confineWrites
			? `- Write only inside your worktree ${guardrails.worktreePath} (and temp dirs). You may read elsewhere, but never edit the main checkout ${guardrails.projectPath} or another card's worktree.`
			: `- Never edit the main checkout ${guardrails.projectPath} or another card's worktree.`,
		`- Never run: ${patterns.join("; ")}. Shared branches: ${shared}. Never rebase, reset or move them; rebasing your own branch onto them is fine.`,
	];
	if (rules.some((rule) => GITHUB_ISSUE_DENY_COMMANDS.includes(rule.pattern))) {
		lines.push(GITHUB_ISSUE_PROMPT_LINE);
	}
	if (unenforced.length > 0) {
		lines.push(`- Not blocked for you (${unenforced.join(", ")}), so these rules rely on you.`);
	}
	return lines.join("\n");
}
