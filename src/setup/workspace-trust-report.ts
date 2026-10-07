// Claude Code / Codex folder trust for registered projects, as `kanban doctor` reports it and `--fix`, `kanban setup`
// and `kanban project add` set it. Trust is keyed by the project's main git root, which covers every task worktree
// of it (src/terminal/workspace-trust-root.ts). A card whose repo isn't trusted sits on the trust dialog, whose
// default answer is "No, exit". Ported from archive/devteam-kit:bin/kit@0782636 (`trustIssues`, kit init's trust).
import { stat } from "node:fs/promises";

import {
	ensureClaudeWorkspaceTrusted,
	getClaudeConfigFilePath,
	isClaudeWorkspaceTrusted,
} from "../terminal/claude-workspace-trust";
import {
	ensureCodexWorkspaceTrusted,
	getCodexConfigFilePath,
	getCodexWorkspaceTrustLevel,
} from "../terminal/codex-workspace-trust";

export interface AgentTrustConfigPaths {
	claude: string;
	codex: string;
}

export function getAgentTrustConfigPaths(): AgentTrustConfigPaths {
	return { claude: getClaudeConfigFilePath(), codex: getCodexConfigFilePath() };
}

/** `absent`: the agent's config file doesn't exist (the agent isn't set up here), so there is nothing to trust. */
export type ClaudeTrustState = "trusted" | "untrusted" | "absent";
/** Codex: `trusted`, `missing` (no table), `absent` (no config.toml), or another trust_level value (left alone). */
export type CodexTrustState = "trusted" | "missing" | "absent" | { level: string };

export interface WorkspaceTrustStatus {
	repoPath: string;
	claude: ClaudeTrustState;
	codex: CodexTrustState;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export async function readWorkspaceTrust(
	repoPath: string,
	paths: AgentTrustConfigPaths = getAgentTrustConfigPaths(),
): Promise<WorkspaceTrustStatus> {
	const [claudeExists, codexExists] = await Promise.all([fileExists(paths.claude), fileExists(paths.codex)]);
	const claude: ClaudeTrustState = !claudeExists
		? "absent"
		: (await isClaudeWorkspaceTrusted(repoPath, { configFilePath: paths.claude }))
			? "trusted"
			: "untrusted";
	let codex: CodexTrustState = "absent";
	if (codexExists) {
		const level = await getCodexWorkspaceTrustLevel(repoPath, { configFilePath: paths.codex });
		codex = level === null ? "missing" : level === "trusted" ? "trusted" : { level };
	}
	return { repoPath, claude, codex };
}

/** True when `kanban doctor --fix` / `kanban setup` would change something for this repo. */
export function workspaceTrustNeedsFix(status: WorkspaceTrustStatus): boolean {
	return status.claude === "untrusted" || status.codex === "missing";
}

/** Trusts the repo for every agent whose config exists. Returns one line per agent it touched. */
export async function fixWorkspaceTrust(
	status: WorkspaceTrustStatus,
	paths: AgentTrustConfigPaths = getAgentTrustConfigPaths(),
): Promise<string[]> {
	const lines: string[] = [];
	if (status.claude === "untrusted") {
		const result = await ensureClaudeWorkspaceTrusted(status.repoPath, { configFilePath: paths.claude });
		lines.push(
			result.error
				? `Claude Code trust for ${result.trustRootPath} not set: ${result.error}`
				: `Claude Code ${result.changed ? "now trusts" : "already trusts"} ${result.trustRootPath}`,
		);
	}
	if (status.codex === "missing") {
		const result = await ensureCodexWorkspaceTrusted(status.repoPath, { configFilePath: paths.codex });
		lines.push(
			result.error
				? `Codex trust for ${result.trustRootPath} not set: ${result.error}`
				: `Codex ${result.changed ? "now trusts" : "already trusts"} ${result.trustRootPath}`,
		);
	}
	return lines;
}
