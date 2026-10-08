// The issue tracker a project imports from (src/issues/). GitHub is the only provider today; GitLab or Gitea plug in
// here by implementing `IssueProvider` and adding their id to `issueProviderIdSchema` (pipeline-config.ts).
//
// Everything a provider returns is untrusted text from the outside world: it only ever reaches an agent through the
// fenced prompt sections of issue-prompt.ts.
import type { IssueProviderId } from "../config/pipeline-config";
import type { RuntimeTaskIssue } from "../core/api-contract";

export interface ProviderIssue {
	number: number;
	title: string;
	body: string;
	url: string;
	state: "open" | "closed";
	author: string;
	/** GitHub's author_association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...). */
	authorAssociation: string;
	labels: string[];
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	/** How many comments the tracker says it has (0 = no comment request needed). */
	commentCount: number;
	/** GitHub lists pull requests as issues; they are never imported. */
	isPullRequest: boolean;
}

export interface ProviderComment {
	id: number;
	author: string;
	authorAssociation: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

/** An issue with its comments (oldest first), as the sync hands it to the planner. */
export interface FetchedIssue extends ProviderIssue {
	comments: ProviderComment[];
}

export interface ListIssuesInput {
	/** `owner/name`. */
	repo: string;
	/** `open` for a first sync; `all` afterwards, so closed issues are seen. */
	state: "open" | "all";
	/** Only issues updated at or after this time; null = all. */
	since: string | null;
}

/** Thrown while the tracker asks us to wait (rate limit); `until` is when the next request may go out. */
export class IssueProviderRateLimitError extends Error {
	readonly until: number;

	constructor(message: string, until: number) {
		super(message);
		this.name = "IssueProviderRateLimitError";
		this.until = until;
	}
}

export interface IssueProvider {
	readonly id: IssueProviderId;
	listIssues: (input: ListIssuesInput) => Promise<ProviderIssue[]>;
	listComments: (repo: string, number: number) => Promise<ProviderComment[]>;
	/** Posts a comment (needs write access). */
	comment: (repo: string, number: number, body: string) => Promise<void>;
}

/** The dedupe key of an issue: provider + repo + number. */
export function issueKey(issue: Pick<RuntimeTaskIssue, "provider" | "repo" | "number">): string {
	return `${issue.provider}:${issue.repo.toLowerCase()}#${issue.number}`;
}

/**
 * The commit-message line that closes the issue when the commit reaches the default branch, or null when the
 * provider has none. GitHub: `Fixes #N` (the landing commit is in the issue's own repository).
 */
export function buildIssueClosingLine(issue: Pick<RuntimeTaskIssue, "provider" | "number">): string | null {
	switch (issue.provider) {
		case "github":
			return `Fixes #${issue.number}`;
	}
	return null;
}
