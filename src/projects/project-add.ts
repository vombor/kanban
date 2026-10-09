// `kanban project add <path>`: register a repo as a Kanban project and set it up in one step. Without `--kit` the
// project is on the `default` kit with landing `off`: every card runs on the agent selected in Kanban settings and
// nothing is QA'd or landed automatically. Nothing is copied from another project (plan §3.4). An already
// configured project keeps its kit and landing mode (`kanban kit apply` changes them); only missing keys are added.
// Ported from archive/devteam-kit:bin/kit@d2fb30f `kit init` (and its trust step from @0782636), with K-1's rule
// that a new project starts with everything off (legacy kit bin/kit@92101ca). A new registration must be strictly
// inside a projects root (src/projects/project-roots.ts).
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
	getWorkspacePipelineSettings,
	type LandingMode,
	readPipelineConfig,
	updateWorkspacePipelineEntry,
} from "../config/pipeline-config";
import { applyWorkspaceKit } from "../kits/apply-kit";
import { DEFAULT_KIT_NAME } from "../kits/resolve-kit";
import { fixWorkspaceTrust, readWorkspaceTrust } from "../setup/workspace-trust-report";
import { listWorkspaceIndexEntries, loadWorkspaceContext } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import { assertPathInsideProjectRoots, type ProjectRoots, readProjectRoots } from "./project-roots";
import { addAgentsQaSection, type ProjectSectionResult } from "./project-sections";

export interface AddProjectInput {
	/** The repo's top directory. */
	repoPath: string;
	kit?: string;
	landing?: LandingMode;
	base?: string;
	name?: string;
	blurb?: string;
	agentsMd?: boolean;
	/** Allow the vetted model registry's provisional combinations for the project (`kit apply --allow-provisional`). */
	allowProvisional?: boolean;
	/** Register a repo without commits (New project with the initial commit turned off). */
	allowUnbornHead?: boolean;
	/** Resolved projects roots (default: config.json's `projects.roots`). */
	projectRoots?: ProjectRoots;
}

export interface AddProjectResult {
	workspaceId: string;
	repoPath: string;
	registered: boolean;
	/** What happened to the workspace's config entry, one line each. */
	config: string[];
	trust: string[];
	agentsMd: ProjectSectionResult | null;
	warnings: string[];
	kitName: string;
	landingMode: LandingMode;
}

/** The repo's top directory, refusing anything Kanban can't run cards in. */
export async function resolveProjectRepoPath(
	path: string,
	options: { allowUnbornHead?: boolean } = {},
): Promise<string> {
	let directory: string;
	try {
		directory = await realpath(path);
		if (!(await stat(directory)).isDirectory()) {
			throw new Error("not a directory");
		}
	} catch {
		throw new Error(`${path} is not a directory.`);
	}
	const top = await runGit(directory, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || !top.stdout) {
		throw new Error(`${directory} is not inside a git repository (git init it and make a first commit).`);
	}
	const topPath = await realpath(top.stdout);
	if (topPath !== directory) {
		throw new Error(`${directory} is not the top of its git repository; add ${topPath} instead.`);
	}
	// A linked worktree (`.git` is a file) is a card's worktree or another checkout of a project: add the main repo.
	const gitEntry = await lstat(join(directory, ".git")).catch(() => null);
	if (gitEntry && !gitEntry.isDirectory()) {
		const common = await runGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const main = common.ok && basename(common.stdout) === ".git" ? dirname(common.stdout) : null;
		throw new Error(
			`${directory} is a linked git worktree (a task worktree?); add the main checkout${main ? ` ${main}` : ""} instead.`,
		);
	}
	const head = await runGit(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	if (!head.ok && !options.allowUnbornHead) {
		throw new Error(`${directory} has no commits yet; Kanban needs one to create task worktrees.`);
	}
	return directory;
}

export async function addProject(input: AddProjectInput): Promise<AddProjectResult> {
	const repoPath = await resolveProjectRepoPath(input.repoPath, { allowUnbornHead: input.allowUnbornHead });
	const before = (await listWorkspaceIndexEntries()).find((entry) => entry.repoPath === repoPath) ?? null;
	// Only new registrations: a project registered outside the roots keeps working (doctor warns about it).
	if (before === null) {
		await assertPathInsideProjectRoots(repoPath, input.projectRoots ?? (await readProjectRoots()));
	}
	const context = await loadWorkspaceContext(repoPath);
	const workspaceId = context.workspaceId;
	const warnings: string[] = [];
	const configLines: string[] = [];

	const { config } = await readPipelineConfig();
	const configured = Object.hasOwn(config.workspaces, workspaceId);
	const current = getWorkspacePipelineSettings(config, workspaceId);
	const currentKitName = current.kit?.name ?? DEFAULT_KIT_NAME;

	if (configured) {
		if (input.kit !== undefined && input.kit !== currentKitName) {
			warnings.push(
				`kit ${input.kit} not applied: ${workspaceId} already uses kit ${currentKitName} (change it with kanban kit apply ${input.kit} --project ${workspaceId})`,
			);
		}
		if (input.landing !== undefined && input.landing !== current.landing.mode) {
			warnings.push(
				`landing ${input.landing} not applied: ${workspaceId} is on landing ${current.landing.mode} (kanban kit apply ${currentKitName} --project ${workspaceId} --landing ${input.landing})`,
			);
		}
	} else if (input.kit !== undefined || input.landing !== undefined || input.blurb !== undefined) {
		const kitName = input.kit ?? DEFAULT_KIT_NAME;
		const applied = await applyWorkspaceKit({
			workspaceId,
			kitName,
			landing: input.landing,
			set: input.blurb !== undefined ? { "qa.blurb": input.blurb } : {},
			allowProvisional: input.allowProvisional,
		});
		configLines.push(`kit ${applied.kitName.to}, landing ${applied.landing.to}`);
		if (applied.recommendedLandingMode && applied.recommendedLandingMode !== applied.landing.to) {
			configLines.push(
				`kit ${kitName} recommends landing "${applied.recommendedLandingMode}"; it is not applied without --landing ${applied.recommendedLandingMode}`,
			);
		}
	}

	// Display keys: added when missing, never changed (an existing value is the user's).
	const additions: Record<string, string> = {};
	if (input.base !== undefined && current.defaultBaseRef === null) {
		additions.defaultBaseRef = input.base;
	} else if (input.base !== undefined && current.defaultBaseRef !== input.base) {
		warnings.push(`--base ${input.base} not applied: the base is already ${current.defaultBaseRef}`);
	}
	if (input.name !== undefined && current.name === null) {
		additions.name = input.name;
	} else if (input.name !== undefined && current.name !== input.name) {
		warnings.push(`--name ${input.name} not applied: the name is already ${current.name}`);
	}
	if (configured && input.blurb !== undefined) {
		if (current.kit?.overrides["qa.blurb"] === undefined) {
			await applyWorkspaceKit({ workspaceId, kitName: currentKitName, set: { "qa.blurb": input.blurb } });
			configLines.push("added the qa.blurb project setting");
		} else {
			warnings.push("--blurb not applied: the qa.blurb project setting is already set (kanban kit set qa.blurb …)");
		}
	}
	if (Object.keys(additions).length > 0) {
		await updateWorkspacePipelineEntry(workspaceId, (entry) => ({ ...entry, ...additions }));
		configLines.push(`set ${Object.keys(additions).join(", ")}`);
	}

	const { config: after } = await readPipelineConfig();
	const settings = getWorkspacePipelineSettings(after, workspaceId);
	if (configLines.length === 0) {
		configLines.push(
			configured || Object.hasOwn(after.workspaces, workspaceId)
				? "already configured; kept as it is"
				: "no entry: kit default, landing off",
		);
	}
	if (settings.landing.mode === "qa" && (settings.kit?.name ?? DEFAULT_KIT_NAME) === DEFAULT_KIT_NAME) {
		warnings.push("landing qa on the default kit: the kit asks for no QA, so every card waits for Approve & land");
	}

	const trust = await fixWorkspaceTrust(await readWorkspaceTrust(repoPath));
	const agentsMd = input.agentsMd
		? await addAgentsQaSection({ config: after, workspaceId, repoPath, dryRun: false })
		: null;

	return {
		workspaceId,
		repoPath,
		registered: before === null,
		config: configLines,
		trust,
		agentsMd,
		warnings,
		kitName: settings.kit?.name ?? DEFAULT_KIT_NAME,
		landingMode: settings.landing.mode,
	};
}
