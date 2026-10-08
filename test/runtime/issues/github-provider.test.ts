import { describe, expect, it } from "vitest";

import {
	createGitHubIssueProvider,
	createMemoryIssueHttpCache,
	readRateLimitUntil,
} from "../../../src/issues/github-provider";
import { IssueProviderRateLimitError } from "../../../src/issues/issue-provider";
import { createFakeGitHub } from "../../utilities/fake-github";

const NOW = Date.parse("2026-10-07T12:00:00Z");

describe("GitHub issue provider", () => {
	it("reuses the ETag: an unchanged list answers 304 and gives the cached issues", async () => {
		const github = createFakeGitHub();
		github.upsertIssue({ number: 1, title: "First", updated_at: "2026-10-01T00:00:00Z" });
		const cache = createMemoryIssueHttpCache({}, () => NOW);
		const provider = createGitHubIssueProvider({ token: null, cache, fetch: github.fetch, now: () => NOW });

		const first = await provider.listIssues({ repo: "vombor/kanban", state: "open", since: null });
		const second = await provider.listIssues({ repo: "vombor/kanban", state: "open", since: null });

		expect(first.map((issue) => issue.number)).toEqual([1]);
		expect(second).toEqual(first);
		expect(github.requests.map((request) => request.status)).toEqual([200, 304]);
		expect(github.requests[0]?.ifNoneMatch).toBeNull();
		expect(github.requests[1]?.ifNoneMatch).toMatch(/^"/u);
		expect(github.requests.every((request) => request.authorization === null)).toBe(true);
	});

	it("follows Link pagination and marks pull requests", async () => {
		const github = createFakeGitHub();
		github.perPage = 2;
		for (let number = 1; number <= 5; number += 1) {
			github.upsertIssue({
				number,
				title: `Issue ${number}`,
				updated_at: `2026-10-0${number}T00:00:00Z`,
				pull_request: number === 3,
			});
		}
		const provider = createGitHubIssueProvider({
			token: "t0k",
			cache: createMemoryIssueHttpCache(),
			fetch: github.fetch,
		});
		const issues = await provider.listIssues({ repo: "vombor/kanban", state: "open", since: null });
		expect(issues.map((issue) => issue.number)).toEqual([1, 2, 3, 4, 5]);
		expect(issues.find((issue) => issue.number === 3)?.isPullRequest).toBe(true);
		expect(github.requests).toHaveLength(3);
		expect(github.requests[0]?.authorization).toBe("Bearer t0k");
	});

	it("throws a rate-limit error with GitHub's reset time on 403 + x-ratelimit-remaining 0", async () => {
		const github = createFakeGitHub();
		github.rateLimit = { status: 403, resetAt: NOW + 30 * 60_000 };
		const provider = createGitHubIssueProvider({
			token: null,
			cache: createMemoryIssueHttpCache(),
			fetch: github.fetch,
			now: () => NOW,
		});
		const error = await provider.listIssues({ repo: "vombor/kanban", state: "open", since: null }).catch((e) => e);
		expect(error).toBeInstanceOf(IssueProviderRateLimitError);
		expect((error as IssueProviderRateLimitError).until).toBe(NOW + 30 * 60_000);
	});

	it("reads retry-after on 429 and treats a plain 403 as a normal error", () => {
		const headers = new Headers({ "retry-after": "120" });
		expect(readRateLimitUntil({ status: 429, headers }, "", NOW)).toBe(NOW + 120_000);
		expect(readRateLimitUntil({ status: 403, headers: new Headers() }, '{"message":"Forbidden"}', NOW)).toBeNull();
		expect(readRateLimitUntil({ status: 200, headers }, "", NOW)).toBeNull();
	});

	it("refuses to comment without a token", async () => {
		const github = createFakeGitHub();
		const provider = createGitHubIssueProvider({
			token: null,
			cache: createMemoryIssueHttpCache(),
			fetch: github.fetch,
		});
		await expect(provider.comment("vombor/kanban", 1, "hi")).rejects.toThrow(/needs a token/u);
		expect(github.requests).toHaveLength(0);
	});

	it("refuses a malformed repository before any request", async () => {
		const github = createFakeGitHub();
		const provider = createGitHubIssueProvider({
			token: null,
			cache: createMemoryIssueHttpCache(),
			fetch: github.fetch,
		});
		await expect(provider.listComments("../../evil", 1)).rejects.toThrow(/owner\/name/u);
		expect(github.requests).toHaveLength(0);
	});

	it("follows the cached next page when a 304 comes without a Link header", async () => {
		const github = createFakeGitHub();
		github.perPage = 1;
		github.upsertIssue({ number: 1, title: "One", updated_at: "2026-10-01T00:00:00Z" });
		github.upsertIssue({ number: 2, title: "Two", updated_at: "2026-10-02T00:00:00Z" });
		const stripLink: typeof github.fetch = async (url, init) => {
			const response = await github.fetch(url, init);
			if (response.status !== 304) {
				return response;
			}
			const headers = new Headers(response.headers);
			headers.delete("link");
			return new Response(null, { status: 304, headers });
		};
		const cache = createMemoryIssueHttpCache();
		const provider = createGitHubIssueProvider({ token: "t", cache, fetch: stripLink });
		await provider.listIssues({ repo: "vombor/kanban", state: "open", since: null });
		const again = await provider.listIssues({ repo: "vombor/kanban", state: "open", since: null });
		expect(again.map((issue) => issue.number)).toEqual([1, 2]);
		expect(github.requests.map((request) => request.status)).toEqual([200, 200, 304, 304]);
	});

	it("refuses a next-page link on another origin, so the token never leaves the API host", async () => {
		const requests: string[] = [];
		const fetch = async (url: string, init: { headers: Record<string, string> }) => {
			requests.push(`${url} ${init.headers.Authorization ?? ""}`);
			return new Response("[]", {
				status: 200,
				headers: { link: '<https://evil.example/repos/vombor/kanban/issues?page=2>; rel="next"' },
			});
		};
		const provider = createGitHubIssueProvider({ token: "t0k", cache: createMemoryIssueHttpCache(), fetch });
		await expect(provider.listIssues({ repo: "vombor/kanban", state: "open", since: null })).rejects.toThrow(
			/not followed/u,
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("https://api.github.com/");
	});
});
