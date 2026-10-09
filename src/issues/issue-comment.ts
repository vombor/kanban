// `issues.commentOnLand` (off by default): when Kanban lands or discards a card imported from an issue (the `qa`
// landing step, src/server/task-landing-gate.ts), it comments on the issue as the machine's Kanban GitHub App, signed
// with the project (src/github-app/issue-writer.ts); until the app exists, with the user's token (issue-auth.ts). Only the project's own repository is ever commented on, and a failure is logged, never fatal:
// the Done has already happened.
import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardCard } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { type GitHubAppTokenSource, getSharedGitHubAppTokenSource } from "../github-app/installation-tokens";
import { performGitHubIssueAction, resolveIssueWriteCredential } from "../github-app/issue-writer";
import { getIssueWorkspacePaths } from "../state/kanban-home";
import type { IssueFetch } from "./github-provider";
import type { IssueAuth } from "./issue-auth";
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
	/** The user's token, used only while there is no Kanban GitHub App. */
	resolveAuth?: () => Promise<IssueAuth>;
	tokenSource?: GitHubAppTokenSource;
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
		const { config } = await readConfig();
		const settings = getWorkspacePipelineSettings(config, input.workspaceId).issues;
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
		try {
			const credential = await resolveIssueWriteCredential({
				repo: repo.repo,
				tokenSource: deps.tokenSource ?? getSharedGitHubAppTokenSource(),
				resolvePat: deps.resolveAuth,
			});
			if (!credential.ok) {
				deps.log?.(`issues ${input.workspaceId}: no comment on ${repo.repo}#${issue.number}: ${credential.error}`);
				return null;
			}
			await performGitHubIssueAction({
				action: {
					action: "comment",
					repo: repo.repo,
					number: issue.number,
					body: buildIssueFinishedComment(input),
				},
				token: credential.credential.token,
				author: { project: input.workspaceId, role: null },
				attribution: config.github,
				http: { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
			});
			const via =
				credential.credential.via === "app"
					? `app ${credential.credential.app.slug}`
					: credential.credential.source;
			return `commented on ${repo.repo}#${issue.number} (${input.outcome}, via ${via})`;
		} catch (error) {
			deps.log?.(
				`issues ${input.workspaceId}: could not comment on ${repo.repo}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	};
}
