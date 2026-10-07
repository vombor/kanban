// `kanban doctor` checks for the home, each registered project (kit, landing, trust, managed sections, worktree push
// hooks) and machine setup. Read-only: a finding's `fix` runs only under `--fix`. Ported from the legacy `kit check`
// (archive/devteam-kit:bin/kit@d2fb30f), with the kit's projects replaced by Kanban's registered workspaces.
import { cp, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LegacyKitProject } from "../config/legacy-kit-config";
import {
	getWorkspacePipelineSettings,
	migrateLegacyConfigKeys,
	type PipelineConfig,
	updatePipelineConfigFile,
} from "../config/pipeline-config";
import { DEFAULT_KIT_NAME, type KitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { addProject, resolveProjectRepoPath } from "../projects/project-add";
import { readAgentsQaSectionStatus, syncProjectSections } from "../projects/project-sections";
import type { SetupStepPlan } from "../setup/machine-setup";
import {
	type AgentTrustConfigPaths,
	fixWorkspaceTrust,
	readWorkspaceTrust,
	type WorkspaceTrustStatus,
} from "../setup/workspace-trust-report";
import type { KanbanHomeSource } from "../state/kanban-home";
import type { KanbanServerLock } from "../state/kanban-server-lock";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import { describeBrokenGitRepository, hasGitRepository } from "../workspace/repo-health";
import type { DoctorFinding } from "./doctor-report";

export interface DoctorProjectContext {
	config: PipelineConfig;
	catalog: KitCatalog;
	entries: RuntimeWorkspaceIndexEntry[];
	/** Projects the legacy kit lists (it owns their AGENTS.md section until cutover). */
	legacyKitProjects: LegacyKitProject[];
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** The registered projects whose repo directory exists. */
export async function filterExistingRepos(
	entries: RuntimeWorkspaceIndexEntry[],
): Promise<RuntimeWorkspaceIndexEntry[]> {
	const exists = await Promise.all(entries.map((entry) => isDirectory(entry.repoPath)));
	return entries.filter((_, index) => exists[index]);
}

export function checkHome(input: {
	homePath: string;
	homeSource: KanbanHomeSource;
	configPath: string;
	configIssues: string[];
	catalog: KitCatalog;
	server: KanbanServerLock | null;
}): DoctorFinding[] {
	const findings: DoctorFinding[] = [
		{ level: "info", area: "home", message: `Kanban home ${input.homePath} (${input.homeSource})` },
	];
	if (input.homeSource === "legacy") {
		findings.push({
			level: "info",
			area: "home",
			message: "this is the legacy home; move it when Kanban is stopped",
			hint: "kanban home migrate --dry-run",
		});
	}
	for (const issue of input.configIssues) {
		findings.push({
			level: "warn",
			area: "home",
			message: `${input.configPath}: ${issue}`,
			hint: "kanban config show",
		});
	}
	for (const error of input.catalog.errors) {
		findings.push({ level: "warn", area: "home", message: `user kit ${error.path} refused: ${error.error}` });
	}
	findings.push({
		level: "info",
		area: "home",
		message: input.server
			? `server running at ${input.server.url} (pid ${input.server.pid})`
			: "no live Kanban server recorded in run/server.json (an older server writes none)",
	});
	return findings;
}

/** The target path given to `kanban doctor <path>`: is it a registered project, and can it become one? */
export async function checkTargetProject(target: string, context: DoctorProjectContext): Promise<DoctorFinding[]> {
	let repoPath: string;
	try {
		repoPath = await resolveProjectRepoPath(target);
	} catch (error) {
		return [{ level: "warn", area: "project", message: error instanceof Error ? error.message : String(error) }];
	}
	if (context.entries.some((entry) => resolve(entry.repoPath) === repoPath)) {
		return [];
	}
	return [
		{
			level: "warn",
			area: "project",
			message: `${repoPath} is not a Kanban project`,
			hint: `kanban project add ${repoPath}`,
			fix: async () => {
				const result = await addProject({ repoPath });
				return [
					`added ${result.workspaceId}: kit ${result.kitName}, landing ${result.landingMode}`,
					...result.trust,
				];
			},
		},
	];
}

export async function checkProjects(context: DoctorProjectContext): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const registered = new Set(context.entries.map((entry) => entry.workspaceId));
	for (const entry of context.entries) {
		if (!(await isDirectory(entry.repoPath))) {
			findings.push({
				level: "fail",
				area: "project",
				message: `${entry.workspaceId}: repo ${entry.repoPath} is missing; its board can't load and its cards can't run`,
				hint: "restore the repo, or remove the project in Kanban",
			});
			continue;
		}
		// The server keeps such a project's board but won't open it (src/server/workspace-registry.ts).
		const broken = hasGitRepository(entry.repoPath) ? null : describeBrokenGitRepository(entry.repoPath);
		if (broken) {
			findings.push({
				level: "fail",
				area: "project",
				message: `${entry.workspaceId}: unhealthy, ${broken.problem}; Kanban keeps its board but can't open it`,
				hint: broken.hint,
			});
		}
		const settings = getWorkspacePipelineSettings(context.config, entry.workspaceId);
		const resolution = resolveWorkspaceKit(context.config, entry.workspaceId, context.catalog);
		const extras = [
			settings.pipeline.shadow ? "shadow" : null,
			Object.keys(resolution.overrides).length > 0 ? `${Object.keys(resolution.overrides).length} overrides` : null,
		].filter(Boolean);
		findings.push({
			level: "info",
			area: "project",
			message: `${entry.workspaceId} (${entry.repoPath}): kit ${resolution.kitName}, landing ${settings.landing.mode}${extras.length ? ` (${extras.join(", ")})` : ""}`,
		});
		for (const issue of resolution.issues) {
			findings.push({
				level: "warn",
				area: "project",
				message: `${entry.workspaceId}: ${issue}`,
				hint: `kanban kit show --project ${entry.workspaceId}`,
			});
		}
		if (settings.landing.mode === "qa" && resolution.kit.qa?.enabled !== true) {
			findings.push({
				level: "info",
				area: "project",
				message: `${entry.workspaceId}: landing qa, but kit ${resolution.kitName} asks for no QA, so every card waits for Approve & land`,
			});
		}
		const recommended = resolution.kit.recommends?.landingMode;
		if (recommended && recommended !== settings.landing.mode && resolution.kitName !== DEFAULT_KIT_NAME) {
			findings.push({
				level: "info",
				area: "project",
				message: `${entry.workspaceId}: kit ${resolution.kitName} recommends landing ${recommended} (now ${settings.landing.mode})`,
				hint: `kanban kit apply ${resolution.kitName} --project ${entry.workspaceId} --landing ${recommended}`,
			});
		}
	}
	for (const workspaceId of Object.keys(context.config.workspaces)) {
		if (!registered.has(workspaceId)) {
			findings.push({
				level: "warn",
				area: "project",
				message: `config.json has settings for ${workspaceId}, which is not a project on this home`,
				hint: "kanban project add <its path>, or remove the entry",
			});
		}
	}
	return findings;
}

export async function checkTrust(repoPaths: string[], trustPaths: AgentTrustConfigPaths): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const statuses: WorkspaceTrustStatus[] = [];
	for (const repoPath of repoPaths) {
		statuses.push(await readWorkspaceTrust(repoPath, trustPaths));
	}
	for (const status of statuses) {
		if (status.claude === "untrusted") {
			findings.push({
				level: "warn",
				area: "trust",
				message: `Claude Code does not trust ${status.repoPath}; its Claude cards stop on the trust dialog`,
				hint: "kanban setup",
				fix: () => fixWorkspaceTrust({ ...status, codex: "trusted" }, trustPaths),
			});
		} else if (status.claude === "trusted") {
			findings.push({ level: "pass", area: "trust", message: `Claude Code trusts ${status.repoPath}` });
		}
		if (status.codex === "missing") {
			findings.push({
				level: "warn",
				area: "trust",
				message: `Codex does not trust ${status.repoPath}; its Codex cards stop on the trust dialog`,
				hint: "kanban setup",
				fix: () => fixWorkspaceTrust({ ...status, claude: "trusted" }, trustPaths),
			});
		} else if (status.codex === "trusted") {
			findings.push({ level: "pass", area: "trust", message: `Codex trusts ${status.repoPath}` });
		} else if (typeof status.codex === "object") {
			findings.push({
				level: "warn",
				area: "trust",
				message: `Codex has trust_level "${status.codex.level}" for ${status.repoPath}; its Codex cards may stop on the trust dialog (left alone: edit ${trustPaths.codex} by hand)`,
			});
		}
	}
	if (statuses.length > 0 && statuses.every((status) => status.claude === "absent")) {
		findings.push({
			level: "info",
			area: "trust",
			message: `Claude Code is not set up here (no ${trustPaths.claude})`,
		});
	}
	return findings;
}

async function mentionsManagedSection(repoPath: string): Promise<boolean> {
	try {
		const text = await readFile(join(repoPath, "AGENTS.md"), "utf8");
		return text.includes("kanban:managed begin agents-qa") || text.includes("kanban-kit:begin agents-qa");
	} catch {
		return false;
	}
}

export async function checkSections(context: DoctorProjectContext): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const legacyKitPaths = new Set(
		context.legacyKitProjects.flatMap((project) => (project.projectPath ? [resolve(project.projectPath)] : [])),
	);
	for (const entry of context.entries) {
		// Most projects have no managed section; don't run git for their base branch.
		if (!(await mentionsManagedSection(entry.repoPath))) {
			continue;
		}
		const status = await readAgentsQaSectionStatus(context.config, entry.workspaceId, entry.repoPath);
		const fix = async () =>
			(
				await syncProjectSections({
					config: context.config,
					workspaceId: entry.workspaceId,
					repoPath: entry.repoPath,
					dryRun: false,
				})
			).map((result) => `${result.filePath}: ${result.detail}`);
		if (status.state === "current") {
			findings.push({ level: "pass", area: "sections", message: `${status.filePath} agents-qa is current` });
		} else if (status.state === "outdated") {
			findings.push({
				level: "warn",
				area: "sections",
				message: `${status.filePath} section agents-qa is out of date`,
				hint: `kanban project sync ${entry.repoPath}`,
				fix,
			});
		} else if (status.state === "legacy" && legacyKitPaths.has(resolve(entry.repoPath))) {
			// One owner: the legacy kit's `kit sync` keeps this section until the project's cutover.
			findings.push({
				level: "info",
				area: "sections",
				message: `${status.filePath} section agents-qa is the legacy kit's (kit sync) until cutover`,
				hint: `kanban project sync ${entry.repoPath} takes it over`,
			});
		} else if (status.state === "legacy") {
			findings.push({
				level: "warn",
				area: "sections",
				message: `${status.filePath} section agents-qa has legacy kit markers and no kit keeps it current`,
				hint: `kanban project sync ${entry.repoPath}`,
				fix,
			});
		}
	}
	return findings;
}

const HOOK_FILES = ["_", "pre-push"];

/**
 * A pre-push hook installed by hand in a project's main checkout (`.husky/pre-push`, untracked, e.g. the secret
 * guard) must be in every linked worktree too: `git worktree add` copies neither `.husky/_` nor `.husky/pre-push`,
 * so a push from a task worktree skipped the guard. Ported from archive/devteam-kit:bin/kit@cb27ad9
 * (`forkHookIssues`), for every registered project instead of the kit's fork clone.
 */
export async function checkWorktreePushHooks(entries: RuntimeWorkspaceIndexEntry[]): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	for (const entry of entries) {
		const source = join(entry.repoPath, ".husky");
		const hasHooks = await Promise.all(HOOK_FILES.map((file) => exists(join(source, file))));
		if (!hasHooks.every(Boolean)) {
			continue;
		}
		const list = await runGit(entry.repoPath, ["worktree", "list", "--porcelain"]);
		if (!list.ok) {
			continue;
		}
		const worktrees = list.stdout
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length));
		for (const worktree of worktrees) {
			if (resolve(worktree) === resolve(entry.repoPath) || !(await isDirectory(worktree))) {
				continue;
			}
			const missing: string[] = [];
			for (const file of HOOK_FILES) {
				if (!(await exists(join(worktree, ".husky", file)))) {
					missing.push(file);
				}
			}
			if (missing.length === 0) {
				continue;
			}
			findings.push({
				level: "warn",
				area: "hooks",
				message: `worktree ${worktree} of ${entry.workspaceId} has no .husky/${missing.join(", .husky/")} from the main checkout; a push from it skips the pre-push hook`,
				hint: `copy them from ${source}`,
				fix: async () => {
					for (const file of missing) {
						await cp(join(source, file), join(worktree, ".husky", file), {
							recursive: true,
							preserveTimestamps: true,
						});
					}
					return [`copied .husky/${missing.join(", .husky/")} into ${worktree}`];
				},
			});
		}
	}
	return findings;
}

/** Keys config.json still has in an older build's form; `--fix` rewrites them (the value is kept). */
export function checkLegacyConfigKeys(rawConfig: Record<string, unknown>, configPath: string): DoctorFinding[] {
	const { migrated } = migrateLegacyConfigKeys(rawConfig);
	if (!migrated.includes("sessionSync")) {
		return [];
	}
	const value = JSON.stringify(rawConfig.sessionSync);
	return [
		{
			level: "warn",
			area: "home",
			message: `${configPath} has the old "sessionSync": ${value}; the core setting is now "sessionSync": { "enabled": ${value} } (both read the same)`,
			hint: "kanban doctor --fix rewrites it",
			fix: async () => {
				await updatePipelineConfigFile((config) => migrateLegacyConfigKeys(config).config, configPath);
				return [`sessionSync: ${value} -> { "enabled": ${value} }`];
			},
		},
	];
}

export function checkSetup(plans: SetupStepPlan[]): DoctorFinding[] {
	return plans.map((plan) => {
		const message = `${plan.id} (${plan.target}): ${plan.details.join("; ")}`;
		switch (plan.status) {
			case "change":
				return { level: "warn", area: "setup", message, hint: "kanban setup" };
			case "error":
				return { level: "warn", area: "setup", message };
			case "skipped":
				return { level: "info", area: "setup", message };
			default:
				return { level: "pass", area: "setup", message };
		}
	});
}
