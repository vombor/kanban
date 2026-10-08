// `issues.commentOnLand` (off by default): when Kanban lands or discards a card imported from an issue (the `qa`
// landing step, src/server/task-landing-gate.ts), it comments on the issue. It needs a token with write access
// (issue-auth.ts). Only the project's own repository is ever commented on, and a failure is logged, never fatal:
// the Done has already happened.
import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardCard } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getIssueWorkspacePaths } from "../state/kanban-home";
import { createGitHubIssueProvider, createMemoryIssueHttpCache, type IssueFetch } from "./github-provider";
import { type IssueAuth, resolveGitHubAuth } from "./issue-auth";
import { type GitRemote, listGitRemotes, resolvePinnedIssueRepo } from "./issue-repo";
import { readIssueSyncState } from "./issue-state";

async function defaultReadPinnedRepo(workspaceId: string): Promise<{ repo: string } | null> {
	return (await readIssueSyncState(getIssueWorkspacePaths(workspaceId).state)).pinnedRepo;
}

export interface IssueCardFinishedInput {
	workspaceId: string;
	workspacePath: string;
	card: RuntimeBoardCard;
	outcome: "landed" | "discarded";
	baseRef: string;
	commit?: string;
}

export interface IssueLandCommenterDependencies {
	readConfig?: () => Promise<ParsedPipelineConfig>;
	listRemotes?: (repoPath: string) => Promise<GitRemote[]>;
	/** The repository the first sync pinned (issue-state.ts), or null. */
	readPinnedRepo?: (workspaceId: string) => Promise<{ repo: string } | null>;
	resolveAuth?: () => Promise<IssueAuth>;
	fetch?: IssueFetch;
	apiOrigin?: string;
	log?: (message: string) => void;
}

export function buildIssueFinishedComment(input: IssueCardFinishedInput): string {
	const plan = resolveCardRole(input.card) === "plan";
	if (input.outcome === "landed") {
		return plan
			? `Kanban landed the plan (spec) of card \`${input.card.id}\` onto \`${input.baseRef}\`${input.commit ? ` as ${input.commit.slice(0, 12)}` : ""}. The work itself follows on cards of its own.`
			: `Kanban landed card \`${input.card.id}\` onto \`${input.baseRef}\`${input.commit ? ` as ${input.commit.slice(0, 12)}` : ""}. The issue closes when that commit reaches the default branch.`;
	}
	return `Kanban finished card \`${input.card.id}\` without landing its work (discarded). The issue stays open.`;
}

/** Comments on the card's issue when the workspace asks for it; resolves to what it did (for the log). */
export function createIssueLandCommenter(
	deps: IssueLandCommenterDependencies = {},
): (input: IssueCardFinishedInput) => Promise<string | null> {
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	return async (input) => {
		const issue = input.card.issue;
		if (!issue) {
			return null;
		}
		const settings = getWorkspacePipelineSettings((await readConfig()).config, input.workspaceId).issues;
		if (!settings.commentOnLand || settings.mode === "off" || settings.provider !== issue.provider) {
			return null;
		}
		const pinned = await (deps.readPinnedRepo ?? defaultReadPinnedRepo)(input.workspaceId).catch(() => undefined);
		if (pinned === undefined) {
			deps.log?.(`issues ${input.workspaceId}: no comment on #${issue.number}: issues-state.json can't be read`);
			return null;
		}
		const repo = resolvePinnedIssueRepo({
			provider: issue.provider,
			configured: settings.repo,
			remotes: await (deps.listRemotes ?? listGitRemotes)(input.workspacePath),
			pinned,
		});
		if (!repo.ok || repo.repo.toLowerCase() !== issue.repo.toLowerCase()) {
			const reason = repo.ok ? `the card's issue is in ${issue.repo}, not ${repo.repo}` : repo.error;
			deps.log?.(`issues ${input.workspaceId}: no comment on #${issue.number}: ${reason}`);
			return null;
		}
		const auth = await (deps.resolveAuth ?? (async () => await resolveGitHubAuth()))();
		const provider = createGitHubIssueProvider({
			token: auth.token,
			cache: createMemoryIssueHttpCache(),
			fetch: deps.fetch,
			apiOrigin: deps.apiOrigin,
		});
		try {
			await provider.comment(repo.repo, issue.number, buildIssueFinishedComment(input));
			return `commented on ${repo.repo}#${issue.number} (${input.outcome}, via ${auth.source})`;
		} catch (error) {
			deps.log?.(
				`issues ${input.workspaceId}: could not comment on ${repo.repo}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	};
}
