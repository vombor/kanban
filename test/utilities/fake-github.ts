// An in-memory GitHub REST API for the issue import and GitHub App tests: the issues and comments endpoints with
// ETags (304 on If-None-Match), Link pagination and a switchable rate limit; issue writes (create, comment, edit,
// close) on any repository; and the app endpoints (manifest conversion, installation lookup, installation tokens).
// Tests pass its `fetch` to the provider, so nothing ever reaches the network.
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
	/** The app side: manifest codes, the repositories the app is installed on, the tokens it minted. */
	app: {
		/** code → the conversion answer (`pem` included). */
		manifestCodes: Map<string, Record<string, unknown>>;
		/** Lowercase owner/name → installation id. */
		installations: Map<string, number>;
		/** Every token minted: installation id, the request body, the token. */
		minted: Array<{ installationId: number; body: unknown; token: string }>;
		/** How long a minted token lives. */
		tokenLifetimeMs: number;
		now: () => number;
	};
	/** Issue writes by any token: repo, method, path, body. */
	writes: Array<{ repo: string; method: string; path: string; body: unknown; authorization: string | null }>;
}

export function createFakeGitHub(repo = "vombor/kanban"): FakeGitHub {
	const issues = new Map<number, FakeGitHubIssue>();
	const comments = new Map<number, FakeGitHubComment[]>();
	const requests: FakeGitHubRequest[] = [];
	let nextIssueNumber = 1000;
	let nextCommentId = 5000;
	const fake: FakeGitHub = {
		issues,
		comments,
		requests,
		app: {
			manifestCodes: new Map(),
			installations: new Map(),
			minted: [],
			tokenLifetimeMs: 60 * 60 * 1000,
			now: Date.now,
		},
		writes: [],
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
			const json = (status: number, body: unknown) => {
				record(status);
				return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			};
			const conversion = /^\/app-manifests\/([^/]+)\/conversions$/u.exec(parsed.pathname);
			if (conversion && init.method === "POST") {
				const answer = fake.app.manifestCodes.get(conversion[1] ?? "");
				fake.app.manifestCodes.delete(conversion[1] ?? "");
				return answer ? json(201, answer) : json(404, { message: "Not Found" });
			}
			const installation = /^\/repos\/([^/]+\/[^/]+)\/installation$/u.exec(parsed.pathname);
			if (installation && init.method === "GET") {
				if (!init.headers.Authorization?.startsWith("Bearer ey")) {
					return json(401, { message: "A JSON web token could not be decoded" });
				}
				const id = fake.app.installations.get((installation[1] ?? "").toLowerCase());
				return id ? json(200, { id }) : json(404, { message: "Not Found" });
			}
			const tokens = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(parsed.pathname);
			if (tokens && init.method === "POST") {
				const installationId = Number(tokens[1]);
				if (![...fake.app.installations.values()].includes(installationId)) {
					return json(404, { message: "Not Found" });
				}
				const token = `ghs_fake${fake.app.minted.length + 1}`;
				fake.app.minted.push({ installationId, body: JSON.parse(init.body ?? "{}"), token });
				return json(201, {
					token,
					expires_at: new Date(fake.app.now() + fake.app.tokenLifetimeMs).toISOString(),
				});
			}
			const write = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(\/comments)?)?$/u.exec(parsed.pathname);
			if (write && (init.method === "POST" || init.method === "PATCH")) {
				const writeRepo = write[1] ?? "";
				const body: unknown = JSON.parse(init.body ?? "{}");
				fake.writes.push({
					repo: writeRepo,
					method: init.method,
					path: parsed.pathname,
					body,
					authorization: init.headers.Authorization ?? null,
				});
				if (init.method === "POST" && !write[2]) {
					nextIssueNumber += 1;
					return json(201, {
						number: nextIssueNumber,
						html_url: `https://github.com/${writeRepo}/issues/${nextIssueNumber}`,
					});
				}
				if (init.method === "POST" && write[3]) {
					nextCommentId += 1;
					return json(201, {
						id: nextCommentId,
						html_url: `https://github.com/${writeRepo}/issues/${write[2]}#issuecomment-${nextCommentId}`,
					});
				}
				if (init.method === "PATCH" && write[2] && !write[3]) {
					return json(200, {
						number: Number(write[2]),
						html_url: `https://github.com/${writeRepo}/issues/${write[2]}`,
					});
				}
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
