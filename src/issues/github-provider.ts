// GitHub's REST API as an IssueProvider. Every GET is a conditional request (If-None-Match with the ETag of the last
// answer for that URL, from the sync's HTTP cache): an unchanged list answers 304 with no body. GitHub doesn't count
// an authenticated 304 against the rate limit; an anonymous one counts like any request (60 requests/h), so an
// anonymous project should poll slowly. The next page's URL is cached with each page, since a 304 may come without
// a Link header, and a next URL on any origin other than the API's is refused, so the token never leaves GitHub.
// A rate-limit answer (403/429 with `x-ratelimit-remaining: 0` or `retry-after`) throws IssueProviderRateLimitError
// with the time GitHub names; the sync then sends nothing until that time.
//
// The token (issue-auth.ts) lives in memory only: never in an error, a log line or a Kanban file.
import { z } from "zod";

import {
	type IssueProvider,
	IssueProviderRateLimitError,
	type ListIssuesInput,
	type ProviderComment,
	type ProviderIssue,
} from "./issue-provider";

export const GITHUB_API_ORIGIN = "https://api.github.com";
const PER_PAGE = 100;
/** At most this many pages per list (10 000 issues or comments). */
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
/** A rate limit that names no time waits this long. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export interface IssueHttpCacheEntry {
	etag: string;
	body: unknown;
	/** The answer's `rel="next"` page, for a 304 that comes without a Link header. */
	next?: string | null;
	/** When the entry was last used (pruning). */
	at: string;
}

/** ETag + body per URL; the sync loads and saves it (issue-state.ts). */
export interface IssueHttpCache {
	get: (url: string) => IssueHttpCacheEntry | null;
	set: (url: string, entry: Omit<IssueHttpCacheEntry, "at">) => void;
	/** Marks an entry used (a 304). */
	touch: (url: string) => void;
}

export function createMemoryIssueHttpCache(
	initial: Record<string, IssueHttpCacheEntry> = {},
	now: () => number = Date.now,
): IssueHttpCache & { entries: () => Record<string, IssueHttpCacheEntry>; changed: () => boolean } {
	const entries = new Map(Object.entries(initial));
	let changed = false;
	return {
		get: (url) => entries.get(url) ?? null,
		set: (url, entry) => {
			entries.set(url, { ...entry, at: new Date(now()).toISOString() });
			changed = true;
		},
		touch: (url) => {
			const entry = entries.get(url);
			if (entry) {
				entries.set(url, { ...entry, at: new Date(now()).toISOString() });
				changed = true;
			}
		},
		entries: () => Object.fromEntries(entries),
		changed: () => changed,
	};
}

export type IssueFetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface GitHubProviderOptions {
	/** null = anonymous. */
	token: string | null;
	cache: IssueHttpCache;
	fetch?: IssueFetch;
	apiOrigin?: string;
	now?: () => number;
}

const githubLabelSchema = z.union([z.string(), z.object({ name: z.string() }).passthrough()]);

const githubIssueSchema = z
	.object({
		number: z.number().int().positive(),
		title: z.string(),
		body: z.string().nullable().optional(),
		html_url: z.string(),
		state: z.enum(["open", "closed"]),
		user: z.object({ login: z.string() }).passthrough().nullable().optional(),
		author_association: z.string().optional(),
		labels: z.array(githubLabelSchema).optional(),
		created_at: z.string(),
		updated_at: z.string(),
		closed_at: z.string().nullable().optional(),
		comments: z.number().int().nonnegative().optional(),
		pull_request: z.unknown().optional(),
	})
	.passthrough();

const githubCommentSchema = z
	.object({
		id: z.number().int(),
		body: z.string().nullable().optional(),
		user: z.object({ login: z.string() }).passthrough().nullable().optional(),
		author_association: z.string().optional(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.passthrough();

function toProviderIssue(raw: z.infer<typeof githubIssueSchema>): ProviderIssue {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		url: raw.html_url,
		state: raw.state,
		author: raw.user?.login ?? "ghost",
		authorAssociation: raw.author_association ?? "NONE",
		labels: (raw.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		closedAt: raw.closed_at ?? null,
		commentCount: raw.comments ?? 0,
		isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
	};
}

function toProviderComment(raw: z.infer<typeof githubCommentSchema>): ProviderComment {
	return {
		id: raw.id,
		author: raw.user?.login ?? "ghost",
		authorAssociation: raw.author_association ?? "NONE",
		body: raw.body ?? "",
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
	};
}

/** The `rel="next"` URL of a Link header, or null. */
export function readNextLink(link: string | null): string | null {
	if (!link) {
		return null;
	}
	for (const part of link.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="?next"?/u.exec(part.trim());
		if (match?.[1]) {
			return match[1];
		}
	}
	return null;
}

/** The time a rate-limited answer says to wait until, or null when the answer isn't a rate limit. */
export function readRateLimitUntil(
	response: { status: number; headers: Headers },
	bodyText: string,
	now: number,
): number | null {
	if (response.status !== 403 && response.status !== 429) {
		return null;
	}
	const retryAfter = Number(response.headers.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return now + retryAfter * 1000;
	}
	if (response.headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(response.headers.get("x-ratelimit-reset"));
		return Number.isFinite(reset) && reset > 0
			? Math.max(reset * 1000, now + 1000)
			: now + DEFAULT_RATE_LIMIT_WAIT_MS;
	}
	if (response.status === 429 || /rate limit/iu.test(bodyText)) {
		return now + DEFAULT_RATE_LIMIT_WAIT_MS;
	}
	return null;
}

export function readGitHubMessage(bodyText: string): string {
	try {
		const parsed = JSON.parse(bodyText) as { message?: unknown };
		return typeof parsed.message === "string" ? parsed.message : bodyText.slice(0, 200);
	} catch {
		return bodyText.slice(0, 200);
	}
}

function assertRepo(repo: string): string {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
		throw new Error(`"${repo}" is not an owner/name repository.`);
	}
	return repo;
}

export function createGitHubIssueProvider(options: GitHubProviderOptions): IssueProvider {
	const doFetch: IssueFetch = options.fetch ?? (async (url, init) => await fetch(url, init));
	const apiOrigin = options.apiOrigin ?? GITHUB_API_ORIGIN;
	const now = options.now ?? Date.now;

	const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "kanban-issue-import",
		...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
		...extra,
	});

	const send = async (
		url: string,
		init: { method: string; headers: Record<string, string>; body?: string },
	): Promise<{ response: Response; text: string }> => {
		const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		const text = response.status === 304 ? "" : await response.text();
		const until = readRateLimitUntil(response, text, now());
		if (until !== null) {
			throw new IssueProviderRateLimitError(
				`GitHub rate limit (HTTP ${response.status}); next request after ${new Date(until).toISOString()}`,
				until,
			);
		}
		return { response, text };
	};

	/** A GET through the ETag cache: the body and the next page's URL. */
	const checkNextUrl = (next: string | null): string | null => {
		if (next === null) {
			return null;
		}
		let origin: string;
		try {
			origin = new URL(next).origin;
		} catch {
			throw new Error("GitHub's next-page link is not a URL; not followed");
		}
		if (origin !== new URL(apiOrigin).origin) {
			throw new Error(`GitHub's next-page link points at ${origin}, not ${new URL(apiOrigin).origin}; not followed`);
		}
		return next;
	};

	const getJson = async (url: string): Promise<{ body: unknown; next: string | null }> => {
		const cached = options.cache.get(url);
		const { response, text } = await send(url, {
			method: "GET",
			headers: headers(cached ? { "If-None-Match": cached.etag } : {}),
		});
		const linked = readNextLink(response.headers.get("link"));
		if (response.status === 304 && cached) {
			options.cache.touch(url);
			return { body: cached.body, next: checkNextUrl(linked ?? cached.next ?? null) };
		}
		const next = checkNextUrl(linked);
		if (!response.ok) {
			throw new Error(
				`GitHub answered HTTP ${response.status} for ${new URL(url).pathname}: ${readGitHubMessage(text)}`,
			);
		}
		const body: unknown = JSON.parse(text);
		const etag = response.headers.get("etag");
		if (etag) {
			options.cache.set(url, { etag, body, next });
		}
		return { body, next };
	};

	const getPages = async (firstUrl: string): Promise<unknown[]> => {
		const items: unknown[] = [];
		let url: string | null = firstUrl;
		for (let page = 0; url && page < MAX_PAGES; page += 1) {
			const { body, next }: { body: unknown; next: string | null } = await getJson(url);
			if (!Array.isArray(body)) {
				throw new Error(`GitHub answered something other than a list for ${new URL(url).pathname}`);
			}
			items.push(...body);
			url = next;
		}
		return items;
	};

	return {
		id: "github",
		listIssues: async (input: ListIssuesInput) => {
			const params = new URLSearchParams({
				state: input.state,
				sort: "updated",
				direction: "asc",
				per_page: String(PER_PAGE),
			});
			if (input.since) {
				params.set("since", input.since);
			}
			const items = await getPages(`${apiOrigin}/repos/${assertRepo(input.repo)}/issues?${params.toString()}`);
			return items.flatMap((item) => {
				const parsed = githubIssueSchema.safeParse(item);
				return parsed.success ? [toProviderIssue(parsed.data)] : [];
			});
		},
		listComments: async (repo, number) => {
			const items = await getPages(
				`${apiOrigin}/repos/${assertRepo(repo)}/issues/${number}/comments?per_page=${PER_PAGE}`,
			);
			return items
				.flatMap((item) => {
					const parsed = githubCommentSchema.safeParse(item);
					return parsed.success ? [toProviderComment(parsed.data)] : [];
				})
				.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
		},
		comment: async (repo, number, body) => {
			if (!options.token) {
				throw new Error("commenting on a GitHub issue needs a token (gh auth login, or GITHUB_TOKEN)");
			}
			const { response, text } = await send(`${apiOrigin}/repos/${assertRepo(repo)}/issues/${number}/comments`, {
				method: "POST",
				headers: headers({ "Content-Type": "application/json" }),
				body: JSON.stringify({ body }),
			});
			if (!response.ok) {
				throw new Error(`GitHub answered HTTP ${response.status} to the comment: ${readGitHubMessage(text)}`);
			}
		},
	};
}
