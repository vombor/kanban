// One GitHub REST request for the app's endpoints and the issue writes: JSON in and out, a 30 s timeout, and errors
// that say what GitHub answered (status, message, the rate limit's reset time) without ever naming the credential.
// Tests pass a fake `fetch` (test/utilities/fake-github.ts), so nothing reaches the network.
import { GITHUB_API_ORIGIN, type IssueFetch, readGitHubMessage, readRateLimitUntil } from "../issues/github-provider";

const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "GitHubApiError";
		this.status = status;
	}
}

export class GitHubRateLimitError extends GitHubApiError {
	readonly until: number;

	constructor(message: string, status: number, until: number) {
		super(message, status);
		this.name = "GitHubRateLimitError";
		this.until = until;
	}
}

export interface GitHubHttpOptions {
	fetch?: IssueFetch;
	apiOrigin?: string;
	now?: () => number;
}

export interface GitHubRequest {
	method: "GET" | "POST" | "PATCH";
	path: string;
	/** `Bearer <jwt or token>`; none for the manifest conversion. */
	bearer?: string | null;
	body?: unknown;
	/** What the request does, for the error message ("creating the issue"). */
	what: string;
}

export async function sendGitHubRequest(
	options: GitHubHttpOptions,
	request: GitHubRequest,
): Promise<{ status: number; body: unknown }> {
	const doFetch: IssueFetch = options.fetch ?? (async (url, init) => await fetch(url, init));
	const now = options.now ?? Date.now;
	const url = `${options.apiOrigin ?? GITHUB_API_ORIGIN}${request.path}`;
	const response = await doFetch(url, {
		method: request.method,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "kanban-github-app",
			...(request.bearer ? { Authorization: `Bearer ${request.bearer}` } : {}),
			...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	const until = readRateLimitUntil(response, text, now());
	if (until !== null) {
		throw new GitHubRateLimitError(
			`GitHub rate limit while ${request.what} (HTTP ${response.status}); try again after ${new Date(until).toISOString()}`,
			response.status,
			until,
		);
	}
	if (!response.ok) {
		throw new GitHubApiError(
			`GitHub answered HTTP ${response.status} while ${request.what}: ${readGitHubMessage(text)}`,
			response.status,
		);
	}
	let body: unknown = null;
	if (text.trim()) {
		try {
			body = JSON.parse(text);
		} catch {
			throw new GitHubApiError(`GitHub answered something other than JSON while ${request.what}`, response.status);
		}
	}
	return { status: response.status, body };
}

export function assertGitHubRepo(repo: string): string {
	const trimmed = repo.trim().replace(/\.git$/u, "");
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(trimmed) || trimmed.split("/").some((part) => /^\.+$/u.test(part))) {
		throw new Error(`"${repo}" is not an owner/name repository.`);
	}
	return trimmed;
}
