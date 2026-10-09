// Issue and comment writes as the machine's Kanban GitHub App, with the user's PAT as the fallback until the app
// exists (docs/fork/github-bots.md). Used by the runtime's `github.issue` route (agents' `kanban github issue ...`)
// and Kanban's own issue comments (the land commenter). Which credential:
//   - the app exists and is installed on the repository: an installation token (installation-tokens.ts);
//   - the app exists but isn't installed there: refused, with the install link (never a silent PAT post);
//   - no app yet: the user's PAT (`gh` login, GITHUB_TOKEN/GH_TOKEN; issue-auth.ts), with a one-line warning.
// Every body gets the attribution line (attribution.ts) before it is sent.
import { z } from "zod";

import { type IssueAuth, resolveGitHubAuth } from "../issues/issue-auth";
import type { GitHubAppInfo } from "./app-credentials";
import { appendAttribution, type GitHubPostAuthor } from "./attribution";
import { assertGitHubRepo, type GitHubHttpOptions, sendGitHubRequest } from "./github-http";
import type { GitHubAppTokenSource } from "./installation-tokens";

export type GitHubIssueAction =
	| { action: "create"; repo: string; title: string; body: string; labels?: string[] }
	| { action: "comment"; repo: string; number: number; body: string }
	| { action: "edit"; repo: string; number: number; title?: string; body?: string }
	| {
			action: "close";
			repo: string;
			number: number;
			reason?: "completed" | "not_planned";
			comment?: string;
	  };

export type IssueWriteCredential =
	| { via: "app"; token: string; app: GitHubAppInfo }
	| { via: "pat"; token: string; source: IssueAuth["source"]; warning: string };

export type IssueWriteCredentialResult =
	| { ok: true; credential: IssueWriteCredential }
	| { ok: false; error: string; installUrl?: string };

export const NO_APP_WARNING =
	"no Kanban GitHub App on this machine yet, so this went out as the user's GitHub login (PAT); the user creates the app with kanban github bot create";

export async function resolveIssueWriteCredential(input: {
	repo: string;
	tokenSource: GitHubAppTokenSource;
	resolvePat?: () => Promise<IssueAuth>;
}): Promise<IssueWriteCredentialResult> {
	const access = await input.tokenSource.tokenForRepo(input.repo);
	if (access.kind === "app") {
		return { ok: true, credential: { via: "app", token: access.token, app: access.app } };
	}
	if (access.kind === "not_installed") {
		return { ok: false, error: access.message, installUrl: access.app.installUrl };
	}
	const pat = await (input.resolvePat ?? (async () => await resolveGitHubAuth()))();
	if (!pat.token) {
		return {
			ok: false,
			error: "no Kanban GitHub App on this machine yet and no GitHub login (gh auth, GITHUB_TOKEN or GH_TOKEN) to fall back to; the user creates the app with kanban github bot create",
		};
	}
	return { ok: true, credential: { via: "pat", token: pat.token, source: pat.source, warning: NO_APP_WARNING } };
}

const issueAnswerSchema = z.object({ number: z.number().int().positive(), html_url: z.string() }).passthrough();
const commentAnswerSchema = z.object({ id: z.number().int(), html_url: z.string() }).passthrough();

export interface GitHubIssueWriteResult {
	number: number;
	url: string;
	/** The comment's URL, for a comment (or a close with a comment). */
	commentUrl: string | null;
}

/** Carries out one action with `token`; bodies get `author`'s attribution line. */
export async function performGitHubIssueAction(input: {
	action: GitHubIssueAction;
	token: string;
	author: GitHubPostAuthor;
	attribution?: { attribution: string; attributionWithoutRole: string };
	http?: GitHubHttpOptions;
}): Promise<GitHubIssueWriteResult> {
	const { action, token, author } = input;
	const http = input.http ?? {};
	const repo = assertGitHubRepo(action.repo);
	const sign = (body: string) => appendAttribution(body, author, input.attribution);
	const postComment = async (number: number, body: string) => {
		const { body: answer } = await sendGitHubRequest(http, {
			method: "POST",
			path: `/repos/${repo}/issues/${number}/comments`,
			bearer: token,
			body: { body: sign(body) },
			what: `commenting on ${repo}#${number}`,
		});
		return commentAnswerSchema.parse(answer).html_url;
	};
	switch (action.action) {
		case "create": {
			const { body } = await sendGitHubRequest(http, {
				method: "POST",
				path: `/repos/${repo}/issues`,
				bearer: token,
				body: {
					title: action.title,
					body: sign(action.body),
					...(action.labels && action.labels.length > 0 ? { labels: action.labels } : {}),
				},
				what: `creating an issue in ${repo}`,
			});
			const issue = issueAnswerSchema.parse(body);
			return { number: issue.number, url: issue.html_url, commentUrl: null };
		}
		case "comment": {
			const commentUrl = await postComment(action.number, action.body);
			return { number: action.number, url: issueUrl(repo, action.number), commentUrl };
		}
		case "edit": {
			const patch: Record<string, string> = {};
			if (action.title !== undefined) {
				patch.title = action.title;
			}
			if (action.body !== undefined) {
				patch.body = sign(action.body);
			}
			if (Object.keys(patch).length === 0) {
				throw new Error("nothing to edit: give a new title or body");
			}
			const { body } = await sendGitHubRequest(http, {
				method: "PATCH",
				path: `/repos/${repo}/issues/${action.number}`,
				bearer: token,
				body: patch,
				what: `editing ${repo}#${action.number}`,
			});
			const issue = issueAnswerSchema.parse(body);
			return { number: issue.number, url: issue.html_url, commentUrl: null };
		}
		case "close": {
			const commentUrl = action.comment ? await postComment(action.number, action.comment) : null;
			const { body } = await sendGitHubRequest(http, {
				method: "PATCH",
				path: `/repos/${repo}/issues/${action.number}`,
				bearer: token,
				body: { state: "closed", state_reason: action.reason ?? "completed" },
				what: `closing ${repo}#${action.number}`,
			});
			const issue = issueAnswerSchema.parse(body);
			return { number: issue.number, url: issue.html_url, commentUrl };
		}
	}
}

function issueUrl(repo: string, number: number): string {
	return `https://github.com/${repo}/issues/${number}`;
}
