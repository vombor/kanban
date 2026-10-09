// `kanban doctor`'s rows for the machine's Kanban GitHub App (docs/fork/github-bots.md): whether it exists (until
// then agents' issues and comments go out with the user's PAT), whether its secrets file is private (0600 in a 0700
// dir; `--fix` tightens it), and whether its installation covers each project's GitHub repository and the shared
// ones (Kanban bug reports), with the install link where it doesn't. Never prints the key or a token.
import { chmod } from "node:fs/promises";
import { dirname } from "node:path";

import type { GitHubSettings } from "../config/pipeline-config";
import {
	GITHUB_APP_DIR_MODE,
	GITHUB_APP_FILE_MODE,
	type GitHubAppFileModes,
	isModeTooOpen,
	readGitHubAppFileModes,
} from "../github-app/app-credentials";
import { createGitHubAppTokenSource, type GitHubAppTokenSource } from "../github-app/installation-tokens";
import { type GitRemote, listGitRemotes, listProviderRepos } from "../issues/issue-repo";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import type { DoctorFinding } from "./doctor-report";

export interface GitHubAppCheckDeps {
	tokenSource: GitHubAppTokenSource;
	readModes: () => Promise<GitHubAppFileModes>;
	listRemotes: (repoPath: string) => Promise<GitRemote[]>;
}

export function createGitHubAppCheckDeps(): GitHubAppCheckDeps {
	return {
		tokenSource: createGitHubAppTokenSource(),
		readModes: async () => await readGitHubAppFileModes(),
		listRemotes: listGitRemotes,
	};
}

const AREA = "setup";

function formatMode(mode: number | null): string {
	return mode === null ? "missing" : `0${mode.toString(8)}`;
}

export async function checkGitHubApp(
	settings: GitHubSettings,
	entries: readonly RuntimeWorkspaceIndexEntry[],
	deps: GitHubAppCheckDeps = createGitHubAppCheckDeps(),
): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	let app: Awaited<ReturnType<GitHubAppTokenSource["getApp"]>>;
	try {
		app = await deps.tokenSource.getApp();
	} catch (error) {
		return [
			{
				level: "fail",
				area: AREA,
				message: `the Kanban GitHub App file can't be used: ${error instanceof Error ? error.message : String(error)}`,
				hint: "kanban github bot create (replaces it; docs/fork/github-bots.md)",
			},
		];
	}
	if (!app) {
		return [
			{
				level: "warn",
				area: AREA,
				message:
					"no Kanban GitHub App on this machine: agents' GitHub issues and comments go out with the user's PAT, unsigned by project",
				hint: "kanban github bot create (once, the user's; docs/fork/github-bots.md)",
			},
		];
	}
	findings.push({
		level: "info",
		area: AREA,
		message: `Kanban GitHub App ${app.slug} (id ${app.appId}, owner ${app.ownerLogin}): agents post issues and comments as ${app.slug}[bot]`,
	});

	const modes = await deps.readModes();
	if (isModeTooOpen(modes.fileMode) || isModeTooOpen(modes.dirMode)) {
		findings.push({
			level: "warn",
			area: AREA,
			message: `the GitHub App's private key file is readable by others: ${modes.path} is ${formatMode(modes.fileMode)}, its dir ${formatMode(modes.dirMode)} (want 0600 and 0700)`,
			hint: `chmod 700 ${dirname(modes.path)} && chmod 600 ${modes.path} (kanban doctor --fix)`,
			fix: async () => {
				await chmod(dirname(modes.path), GITHUB_APP_DIR_MODE);
				await chmod(modes.path, GITHUB_APP_FILE_MODE);
				return [`chmod 700 ${dirname(modes.path)}`, `chmod 600 ${modes.path}`];
			},
		});
	}

	const repos = new Map<string, string[]>();
	const addRepo = (repo: string, owner: string) => {
		const key = repo.toLowerCase();
		repos.set(key, [...(repos.get(key) ?? []), owner]);
	};
	for (const entry of entries) {
		const origin = listProviderRepos("github", await deps.listRemotes(entry.repoPath).catch(() => [])).find(
			(remote) => remote.remote === "origin",
		);
		if (origin) {
			addRepo(origin.repo, entry.workspaceId);
		}
	}
	for (const repo of settings.sharedRepos) {
		addRepo(repo, "github.sharedRepos");
	}
	const missing: string[] = [];
	for (const [repo, owners] of repos) {
		try {
			const found = await deps.tokenSource.findInstallation(repo);
			if (found.kind === "not_installed") {
				missing.push(`${repo} (${owners.join(", ")})`);
			}
		} catch (error) {
			findings.push({
				level: "warn",
				area: AREA,
				message: `not checked whether the GitHub App covers ${repo} (${owners.join(", ")}): ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	if (missing.length > 0) {
		findings.push({
			level: "warn",
			area: AREA,
			message: `the Kanban GitHub App is not installed on ${missing.join(", ")}: agents' posts there are refused`,
			hint: `install it on All repositories (or add these): ${app.installUrl}`,
		});
	} else if (repos.size > 0) {
		findings.push({
			level: "pass",
			area: AREA,
			message: `the Kanban GitHub App covers every project's GitHub repository and the shared ones (${repos.size})`,
		});
	}
	return findings;
}
