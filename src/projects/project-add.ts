// `kanban project add <path>`: register a repo as a Kanban project and set it up in one step. A new project picks its
// routing kit here (`--kit`, or the CLI's prompt through `chooseKit`; src/kits/kit-choices.ts), checked before
// anything is registered. Without one it is on the `default` kit with landing `off`: every card runs on the agent
// selected in Kanban settings and nothing is QA'd or landed automatically. Nothing is copied from another project
// (plan §3.4). An already configured project keeps its kit and landing mode (`kanban kit apply` changes them); only
// missing keys are added.
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
import {
	type KitChoiceList,
	listKitChoices,
	type NewProjectKitSelection,
	resolveNewProjectKit,
} from "../kits/kit-choices";
import { formatKitSelection, formatKitSelectionArgs, type KitSelection } from "../kits/renamed-kits";
import { DEFAULT_KIT_NAME, loadKitCatalog } from "../kits/resolve-kit";
import { fixWorkspaceTrust, readWorkspaceTrust } from "../setup/workspace-trust-report";
import { listWorkspaceIndexEntries, loadWorkspaceContext } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import { assertPathInsideProjectRoots, type ProjectRoots, readProjectRoots } from "./project-roots";
import { addAgentsQaSection, type ProjectSectionResult } from "./project-sections";

export interface AddProjectInput {
	/** The repo's top directory. */
	repoPath: string;
	kit?: string;
	/** The `team` kit's preset; null = a custom team (`roleSettings` name its models). */
	preset?: string | null;
	/** A custom team's `roles.<role>.agent|provider|model` (dev and QA agents required). */
	roleSettings?: Record<string, unknown>;
	/** Asks for the kit of a new registration given no `kit` (the CLI's terminal prompt); absent: `default`. */
	chooseKit?: (choices: KitChoiceList) => Promise<NewProjectKitSelection>;
	landing?: LandingMode;
	base?: string;
	name?: string;
	blurb?: string;
	agentsMd?: boolean;
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
	/** The `team` kit's preset (null: none). */
	presetName: string | null;
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

/** A new registration's kit: the named one, else the asked one, else `default`; refused if it doesn't resolve. */
export async function chooseNewProjectKit(
	input: Pick<AddProjectInput, "kit" | "preset" | "roleSettings" | "chooseKit">,
): Promise<NewProjectKitSelection | undefined> {
	if (input.kit === undefined && !input.chooseKit) {
		return undefined;
	}
	const catalog = await loadKitCatalog();
	const picked =
		input.kit !== undefined
			? { kit: input.kit, preset: input.preset, roleSettings: input.roleSettings }
			: await input.chooseKit?.(listKitChoices(catalog)).then((choice) => ({
					kit: choice.name,
					preset: choice.preset,
					roleSettings: choice.roleSettings,
				}));
	return resolveNewProjectKit(catalog, picked ?? {});
}

function isSameKit(left: KitSelection, right: KitSelection): boolean {
	return left.name === right.name && left.preset === right.preset;
}

function describeKeptKit(workspaceId: string, kit: KitSelection, current: KitSelection): string {
	return `kit ${formatKitSelection(kit)} not applied: ${workspaceId} already uses kit ${formatKitSelection(current)} (change it with kanban kit apply ${formatKitSelectionArgs(kit)} --project ${workspaceId})`;
}

function readCurrentKit(settings: { kit: { name: string; preset: string | null } | null }): KitSelection {
	return { name: settings.kit?.name ?? DEFAULT_KIT_NAME, preset: settings.kit?.preset ?? null };
}

/**
 * The kit picked for a project the browser just registered (Open folder, Clone), through `kanban kit apply`'s code:
 * `default` writes nothing, and a project that already has a config entry keeps its kit. Returns notes for the user.
 */
export async function applyNewProjectKit(workspaceId: string, kit: NewProjectKitSelection): Promise<string[]> {
	const { config } = await readPipelineConfig();
	if (Object.hasOwn(config.workspaces, workspaceId)) {
		const current = readCurrentKit(getWorkspacePipelineSettings(config, workspaceId));
		return isSameKit(kit, current) ? [] : [describeKeptKit(workspaceId, kit, current)];
	}
	if (kit.name === DEFAULT_KIT_NAME) {
		return [];
	}
	const applied = await applyWorkspaceKit({
		workspaceId,
		kitName: kit.name,
		preset: kit.preset,
		set: kit.roleSettings,
	});
	return applied.recommendedLandingMode && applied.recommendedLandingMode !== applied.landing.to
		? [
				`Kit ${formatKitSelection(kit)} recommends landing "${applied.recommendedLandingMode}" (kanban kit apply ${formatKitSelectionArgs(kit)} --project ${workspaceId} --landing ${applied.recommendedLandingMode}).`,
			]
		: [];
}

export async function addProject(input: AddProjectInput): Promise<AddProjectResult> {
	const repoPath = await resolveProjectRepoPath(input.repoPath, { allowUnbornHead: input.allowUnbornHead });
	const before = (await listWorkspaceIndexEntries()).find((entry) => entry.repoPath === repoPath) ?? null;
	// Only new registrations: a project registered outside the roots keeps working (doctor warns about it).
	if (before === null) {
		await assertPathInsideProjectRoots(repoPath, input.projectRoots ?? (await readProjectRoots()));
	}
	const kit = before === null ? await chooseNewProjectKit(input) : undefined;
	const context = await loadWorkspaceContext(repoPath);
	const workspaceId = context.workspaceId;
	const warnings: string[] = [];
	const configLines: string[] = [];

	const { config } = await readPipelineConfig();
	const configured = Object.hasOwn(config.workspaces, workspaceId);
	const current = getWorkspacePipelineSettings(config, workspaceId);
	const currentKit = readCurrentKit(current);
	const currentKitName = currentKit.name;
	// A registered project given --kit keeps its own; the given kit only names what was asked for.
	const askedKit: KitSelection | undefined =
		kit ?? (input.kit !== undefined ? { name: input.kit, preset: input.preset ?? null } : undefined);

	if (configured) {
		if (askedKit !== undefined && !isSameKit(askedKit, currentKit)) {
			warnings.push(describeKeptKit(workspaceId, askedKit, currentKit));
		}
		if (input.landing !== undefined && input.landing !== current.landing.mode) {
			warnings.push(
				`landing ${input.landing} not applied: ${workspaceId} is on landing ${current.landing.mode} (kanban kit apply ${formatKitSelectionArgs(currentKit)} --project ${workspaceId} --landing ${input.landing})`,
			);
		}
	} else if (
		(kit !== undefined && kit.name !== DEFAULT_KIT_NAME) ||
		input.landing !== undefined ||
		input.blurb !== undefined
	) {
		// `default` alone writes no entry (no entry is default), as without a kit.
		const chosen: NewProjectKitSelection = kit ?? { name: DEFAULT_KIT_NAME, preset: null, roleSettings: {} };
		const applied = await applyWorkspaceKit({
			workspaceId,
			kitName: chosen.name,
			preset: chosen.preset,
			landing: input.landing,
			set: { ...chosen.roleSettings, ...(input.blurb !== undefined ? { "qa.blurb": input.blurb } : {}) },
		});
		configLines.push(
			`kit ${formatKitSelection({ name: applied.kitName.to, preset: applied.preset.to })}, landing ${applied.landing.to}`,
		);
		if (applied.recommendedLandingMode && applied.recommendedLandingMode !== applied.landing.to) {
			configLines.push(
				`kit ${formatKitSelection(chosen)} recommends landing "${applied.recommendedLandingMode}"; it is not applied without --landing ${applied.recommendedLandingMode}`,
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
		presetName: settings.kit?.preset ?? null,
		landingMode: settings.landing.mode,
	};
}
