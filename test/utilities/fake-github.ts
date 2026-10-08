// An in-memory GitHub REST API for the issue import tests: the issues and comments endpoints with ETags (304 on
// If-None-Match), Link pagination and a switchable rate limit. Tests pass its `fetch` to the provider, so nothing
// ever reaches the network.
import { createHash } from "node:crypto";

import type { IssueFetch } from "../../src/issues/github-provider";

export interface FakeGitHubIssue {
	number: number;
	title: string;
	body?: string;
	state?: "open" | "closed";
	user?: string;
	author_association?: string;
	labels?: string[];
	created_at?: string;
	updated_at: string;
	closed_at?: string | null;
	pull_request?: boolean;
}

export interface FakeGitHubComment {
	id: number;
	body: string;
	user?: string;
	author_association?: string;
	created_at: string;
}

export interface FakeGitHubRequest {
	method: string;
	url: string;
	ifNoneMatch: string | null;
	authorization: string | null;
	status: number;
	body?: string;
}

export interface FakeGitHub {
	fetch: IssueFetch;
	requests: FakeGitHubRequest[];
	issues: Map<number, FakeGitHubIssue>;
	comments: Map<number, FakeGitHubComment[]>;
	/** Set to make every request answer a rate limit until cleared. */
	rateLimit: { status: 403 | 429; resetAt?: number; retryAfterSec?: number } | null;
	/** Page size for lists (to test pagination). */
	perPage: number;
	upsertIssue: (issue: FakeGitHubIssue) => void;
	addComment: (number: number, comment: FakeGitHubComment) => void;
}

export function createFakeGitHub(repo = "vombor/kanban"): FakeGitHub {
	const issues = new Map<number, FakeGitHubIssue>();
	const comments = new Map<number, FakeGitHubComment[]>();
	const requests: FakeGitHubRequest[] = [];
	const fake: FakeGitHub = {
		issues,
		comments,
		requests,
		rateLimit: null,
		perPage: 100,
		upsertIssue: (issue) => {
			issues.set(issue.number, issue);
		},
		addComment: (number, comment) => {
			comments.set(number, [...(comments.get(number) ?? []), comment]);
		},
		fetch: async (url, init) => {
			const parsed = new URL(url);
			const ifNoneMatch = init.headers["If-None-Match"] ?? null;
			const record = (status: number): void => {
				requests.push({
					method: init.method,
					url,
					ifNoneMatch,
					authorization: init.headers.Authorization ?? null,
					status,
					...(init.body ? { body: init.body } : {}),
				});
			};
			if (fake.rateLimit) {
				record(fake.rateLimit.status);
				const headers: Record<string, string> = { "x-ratelimit-remaining": "0" };
				if (fake.rateLimit.resetAt) {
					headers["x-ratelimit-reset"] = String(Math.floor(fake.rateLimit.resetAt / 1000));
				}
				if (fake.rateLimit.retryAfterSec) {
					headers["retry-after"] = String(fake.rateLimit.retryAfterSec);
				}
				return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
					status: fake.rateLimit.status,
					headers,
				});
			}
			const base = `/repos/${repo}/issues`;
			let items: unknown[];
			if (parsed.pathname === base && init.method === "GET") {
				const state = parsed.searchParams.get("state") ?? "open";
				const since = parsed.searchParams.get("since");
				items = [...issues.values()]
					.filter((issue) => state === "all" || (issue.state ?? "open") === state)
					.filter((issue) => !since || Date.parse(issue.updated_at) >= Date.parse(since))
					.sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))
					.map((issue) => ({
						number: issue.number,
						title: issue.title,
						body: issue.body ?? "",
						html_url: `https://github.com/${repo}/issues/${issue.number}`,
						state: issue.state ?? "open",
						user: { login: issue.user ?? "alice" },
						author_association: issue.author_association ?? "OWNER",
						labels: (issue.labels ?? []).map((name) => ({ name })),
						created_at: issue.created_at ?? "2026-10-01T00:00:00Z",
						updated_at: issue.updated_at,
						closed_at: issue.closed_at ?? null,
						comments: comments.get(issue.number)?.length ?? 0,
						...(issue.pull_request ? { pull_request: { url: "x" } } : {}),
					}));
			} else {
				const match = new RegExp(`^${base}/(\\d+)/comments$`, "u").exec(parsed.pathname);
				if (!match) {
					record(404);
					return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
				}
				const number = Number(match[1]);
				if (init.method === "POST") {
					record(201);
					return new Response(JSON.stringify({ id: 1 }), { status: 201 });
				}
				items = (comments.get(number) ?? []).map((comment) => ({
					id: comment.id,
					body: comment.body,
					user: { login: comment.user ?? "bob" },
					author_association: comment.author_association ?? "NONE",
					created_at: comment.created_at,
					updated_at: comment.created_at,
				}));
			}
			const page = Number(parsed.searchParams.get("page") ?? "1");
			const pageItems = items.slice((page - 1) * fake.perPage, page * fake.perPage);
			const headers: Record<string, string> = {};
			if (page * fake.perPage < items.length) {
				const next = new URL(url);
				next.searchParams.set("page", String(page + 1));
				headers.link = `<${next.toString()}>; rel="next"`;
			}
			const body = JSON.stringify(pageItems);
			const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
			headers.etag = etag;
			if (ifNoneMatch === etag) {
				record(304);
				return new Response(null, { status: 304, headers });
			}
			record(200);
			return new Response(body, { status: 200, headers });
		},
	};
	return fake;
}
