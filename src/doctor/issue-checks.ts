// `kanban doctor`'s issue import rows (src/issues/): per project with `issues.mode` not off, its mode, the repository
// it imports from (refused when `issues.repo` isn't one of its own remotes), where the token comes from (never the
// token), the last sync and how many issues were skipped by reason. The worker's sync job runs in the watchdog's job
// runner, so a project in `report`/`on` with the watchdog not `on` only syncs through `kanban issues sync`.
import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import type { IssueAuthSource } from "../issues/issue-auth";
import { type GitRemote, listGitRemotes, resolvePinnedIssueRepo } from "../issues/issue-repo";
import { type IssueSyncState, readIssueSyncState } from "../issues/issue-state";
import { getIssueWorkspacePaths } from "../state/kanban-home";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import type { DoctorFinding } from "./doctor-report";

export interface IssueCheckDeps {
	listRemotes: (repoPath: string) => Promise<GitRemote[]>;
	readState: (workspaceId: string) => Promise<IssueSyncState>;
	authSource: () => Promise<IssueAuthSource>;
}

const AREA = "issues" as const;

export async function checkIssueImport(
	config: PipelineConfig,
	entries: readonly RuntimeWorkspaceIndexEntry[],
	deps: IssueCheckDeps,
): Promise<DoctorFinding[]> {
	const active = entries.filter(
		(entry) => getWorkspacePipelineSettings(config, entry.workspaceId).issues.mode !== "off",
	);
	if (active.length === 0) {
		return [];
	}
	const findings: DoctorFinding[] = [];
	const authSource = await deps.authSource();
	const watchdogOn = config.watchdog.mode === "on";
	for (const entry of active) {
		const settings = getWorkspacePipelineSettings(config, entry.workspaceId);
		const issues = settings.issues;
		const label = settings.name
			? `workspace ${settings.name} (${entry.workspaceId})`
			: `workspace ${entry.workspaceId}`;
		let state: IssueSyncState;
		try {
			state = await deps.readState(entry.workspaceId);
		} catch (error) {
			findings.push({
				level: "fail",
				area: AREA,
				message: `${label}: issue import ${issues.mode} is stopped: ${error instanceof Error ? error.message : String(error)}`,
				hint: "fix the JSON by hand (the copy keeps the original), or remove the file to start over",
			});
			continue;
		}
		const repo = resolvePinnedIssueRepo({
			provider: issues.provider,
			configured: issues.repo,
			remotes: await deps.listRemotes(entry.repoPath),
			pinned: state.pinnedRepo,
		});
		if (!repo.ok) {
			findings.push({
				level: "fail",
				area: AREA,
				message: `${label}: issue import ${issues.mode} is refused: ${repo.error}`,
				hint: `set workspaces.${entry.workspaceId}.issues.repo to one of the project's own remotes, or null for origin`,
			});
			continue;
		}
		const last = state.lastSync;
		const skipped = Object.values(state.skipped).reduce<Record<string, number>>((counts, skip) => {
			counts[skip.reason] = (counts[skip.reason] ?? 0) + 1;
			return counts;
		}, {});
		const skippedText = Object.entries(skipped)
			.map(([reason, count]) => `${reason} ${count}`)
			.join(", ");
		findings.push({
			level: last && !last.ok ? "warn" : "info",
			area: AREA,
			message: `${label}: issue import ${issues.mode} from ${issues.provider} ${repo.repo} (${repo.source === "origin" ? "origin" : "issues.repo"}), every ${issues.pollMin} min, auth ${authSource}; last sync ${last ? `${last.at} ${last.ok ? "ok" : `failed: ${last.error}`}` : "never"}; imported ${Object.keys(state.issues).length}, skipped ${Object.keys(state.skipped).length}${skippedText ? ` (${skippedText})` : ""}${state.backoff.until ? `; rate limited until ${state.backoff.until}` : ""}`,
			...(last && !last.ok
				? { hint: `kanban issues sync --project-path ${entry.repoPath} --dry-run shows what fails` }
				: {}),
		});
		if (!watchdogOn) {
			findings.push({
				level: "warn",
				area: AREA,
				message: `${label}: issue import is ${issues.mode}, but the pipeline worker's sync job only runs with watchdog.mode on (it is ${config.watchdog.mode}); nothing syncs on its own`,
				hint: `set "watchdog": { "mode": "on" } in config.json, or run kanban issues sync --project-path ${entry.repoPath}`,
			});
		}
		if (issues.commentOnLand && authSource === "anonymous") {
			findings.push({
				level: "warn",
				area: AREA,
				message: `${label}: issues.commentOnLand is on but there is no GitHub token (anonymous): comments will fail`,
				hint: "gh auth login, or set GITHUB_TOKEN in Kanban's environment",
			});
		}
		if (authSource === "anonymous") {
			findings.push({
				level: "info",
				area: AREA,
				message: `${label}: anonymous GitHub access allows 60 requests/h, and every request counts (only authenticated 304 answers are free), so a short pollMin or a busy repository can hit the limit`,
				hint: "gh auth login, or set GH_TOKEN / GITHUB_TOKEN in Kanban's environment",
			});
		}
	}
	return findings;
}

export function createIssueCheckDeps(authSource: () => Promise<IssueAuthSource>): IssueCheckDeps {
	return {
		listRemotes: listGitRemotes,
		readState: async (workspaceId) => await readIssueSyncState(getIssueWorkspacePaths(workspaceId).state),
		authSource,
	};
}
