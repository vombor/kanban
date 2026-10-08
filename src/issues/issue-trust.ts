// The trust filter: which issues may become cards. Issue text becomes an agent prompt, and anyone can open an issue on
// a public repository, so the default is strict (pipeline-config.ts `issues.filter`): an open issue (never a pull
// request) is imported only if its author is the repository's OWNER, a MEMBER of its organization or a COLLABORATOR,
// or if it carries a trust label (`kanban`), which only someone with triage rights can apply. Exclude labels always
// win; include labels, when set, narrow further.
import type { WorkspaceIssuesSettings } from "../config/pipeline-config";
import type { ProviderIssue } from "./issue-provider";

export type IssueSkipReason =
	| "pull-request"
	| "closed"
	| "excluded-label"
	| "missing-include-label"
	| "untrusted-author";

export type IssueTrustDecision =
	| { import: true; via: "author" | "label"; detail: string }
	| { import: false; reason: IssueSkipReason; detail: string };

function hasLabel(issue: Pick<ProviderIssue, "labels">, labels: readonly string[]): string | null {
	const wanted = new Set(labels.map((label) => label.toLowerCase()));
	return issue.labels.find((label) => wanted.has(label.toLowerCase())) ?? null;
}

/** Whether a new issue may be imported. (An already imported issue keeps its card whatever happens to its labels.) */
export function evaluateIssueTrust(
	issue: Pick<ProviderIssue, "isPullRequest" | "state" | "labels" | "author" | "authorAssociation">,
	filter: WorkspaceIssuesSettings["filter"],
): IssueTrustDecision {
	if (issue.isPullRequest) {
		return { import: false, reason: "pull-request", detail: "a pull request, not an issue" };
	}
	if (issue.state !== "open") {
		return { import: false, reason: "closed", detail: "closed" };
	}
	const excluded = hasLabel(issue, filter.excludeLabels);
	if (excluded) {
		return { import: false, reason: "excluded-label", detail: `has the exclude label "${excluded}"` };
	}
	if (filter.includeLabels.length > 0 && !hasLabel(issue, filter.includeLabels)) {
		return {
			import: false,
			reason: "missing-include-label",
			detail: `has none of the include labels (${filter.includeLabels.join(", ")})`,
		};
	}
	const association = issue.authorAssociation.toUpperCase();
	if (filter.trustedAssociations.some((trusted) => trusted.toUpperCase() === association)) {
		return { import: true, via: "author", detail: `author ${issue.author} is ${association}` };
	}
	const trustLabel = hasLabel(issue, filter.trustLabels);
	if (trustLabel) {
		return { import: true, via: "label", detail: `has the trust label "${trustLabel}"` };
	}
	return {
		import: false,
		reason: "untrusted-author",
		detail: `author ${issue.author} is ${association} and the issue has no trust label (${filter.trustLabels.join(", ") || "none configured"})`,
	};
}

/** Whether a GitHub author_association is one the filter trusts (issue authors and commenters alike). */
export function isTrustedAssociation(association: string, filter: WorkspaceIssuesSettings["filter"]): boolean {
	const upper = association.toUpperCase();
	return filter.trustedAssociations.some((trusted) => trusted.toUpperCase() === upper);
}

/**
 * Whether an imported issue may still add text to its card: its author is trusted, or it still carries a trust
 * label and no exclude label. Removing the label stops updates.
 */
export function isIssueStillTrusted(
	issue: Pick<ProviderIssue, "labels" | "authorAssociation">,
	filter: WorkspaceIssuesSettings["filter"],
): boolean {
	if (hasLabel(issue, filter.excludeLabels)) {
		return false;
	}
	return isTrustedAssociation(issue.authorAssociation, filter) || hasLabel(issue, filter.trustLabels) !== null;
}
