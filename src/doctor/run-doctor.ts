// `kanban doctor [path] [--fix] [--deep]`: one pass over the home, the projects, agent trust, managed sections,
// machine setup and the "one owner" check. Fast and read-only unless `--fix`, which runs only the safe fixes
// (register the given project with the default kit, trust, managed sections, worktree push hooks). Machine setup
// drift is reported, and `kanban setup` fixes it: setup writes user files (CLAUDE.md, providers.json).
import { listLegacyKitProjects, readLegacyKitConfig, readLegacyKitServices } from "../config/legacy-kit-config";
import { readPipelineConfig, readRawGlobalConfig } from "../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import { loadKitCatalog } from "../kits/resolve-kit";
import { buildLemonadeModelListUrl, planClineModelsSource } from "../setup/cline-models-source";
import { planMachineSetup } from "../setup/machine-setup";
import { getAgentTrustConfigPaths } from "../setup/workspace-trust-report";
import { getClineModelsSettingsPath, resolveKanbanHome } from "../state/kanban-home";
import { readLiveKanbanServerLock } from "../state/kanban-server-lock";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "../state/workspace-state";
import { createDeepCheckDeps, type DeepCheckDeps, runDeepChecks } from "./deep-checks";
import {
	checkHome,
	checkLegacyConfigKeys,
	checkProjects,
	checkSections,
	checkSetup,
	checkTargetProject,
	checkTrust,
	checkWorktreePushHooks,
	filterExistingRepos,
} from "./doctor-checks";
import type { DoctorFinding, DoctorFixOutcome, DoctorReport } from "./doctor-report";
import { checkOneOwner } from "./one-owner-checks";

export interface DoctorOptions {
	/** `kanban doctor <path>`: a project that should be registered. */
	target?: string;
	fix: boolean;
	deep: boolean;
	/** Kanban server origin agent CLIs should call (for the Cline model-list check). */
	origin: string;
	kanbanVersion: string;
	deepDeps?: DeepCheckDeps;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
	const home = resolveKanbanHome();
	const [{ config, issues, configPath }, catalog, entries, legacyKit] = await Promise.all([
		readPipelineConfig(),
		loadKitCatalog(),
		listWorkspaceIndexEntries(),
		readLegacyKitConfig(),
	]);
	const legacyKitProjects = legacyKit.raw ? listLegacyKitProjects(legacyKit.raw) : [];
	const projectContext = { config, catalog, entries, legacyKitProjects };
	const findings: DoctorFinding[] = [];

	findings.push(
		...checkHome({
			homePath: home.homePath,
			homeSource: home.source,
			configPath,
			configIssues: issues,
			catalog,
			server: readLiveKanbanServerLock(home.homePath),
		}),
	);
	findings.push(...checkLegacyConfigKeys(await readRawGlobalConfig(configPath), configPath));
	if (options.target) {
		findings.push(...(await checkTargetProject(options.target, projectContext)));
	}
	findings.push(...(await checkProjects(projectContext)));

	// checkProjects reports projects whose repo is gone; the per-repo checks skip them.
	const liveEntries = await filterExistingRepos(entries);
	findings.push(
		...(await checkTrust(
			liveEntries.map((entry) => entry.repoPath),
			getAgentTrustConfigPaths(),
		)),
	);
	findings.push(...(await checkSections({ ...projectContext, entries: liveEntries })));
	findings.push(...(await checkWorktreePushHooks(liveEntries)));

	findings.push(
		...checkSetup(
			await planMachineSetup({
				origin: options.origin,
				legacyKitInstalled: legacyKit.raw !== null,
				config,
			}),
		),
	);

	const modelsSource = await planClineModelsSource(
		getClineModelsSettingsPath(config.agents.cline.dataDir),
		buildLemonadeModelListUrl(options.origin),
	);
	findings.push(
		...(await checkOneOwner({
			legacyKit,
			services: legacyKit.raw ? readLegacyKitServices(legacyKit.raw) : [],
			config,
			entries,
			loadBoard: async (workspaceId) => await loadWorkspaceBoardById(workspaceId).catch(() => null),
			clineModelsSourceUrl: modelsSource.currentUrl,
		})),
	);

	if (options.deep) {
		const runtimeConfig = await loadGlobalRuntimeConfig();
		findings.push(
			...(await runDeepChecks(
				{
					kanbanVersion: options.kanbanVersion,
					selectedAgentId: runtimeConfig.selectedAgentId,
					defaultProvider: config.models.providers.default,
				},
				options.deepDeps ?? createDeepCheckDeps(config),
			)),
		);
	}

	const fixes: DoctorFixOutcome[] = [];
	if (options.fix) {
		for (const finding of findings) {
			if (!finding.fix) {
				continue;
			}
			try {
				fixes.push({ message: finding.message, lines: await finding.fix(), error: null });
			} catch (error) {
				fixes.push({
					message: finding.message,
					lines: [],
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return { findings, fixes };
}
