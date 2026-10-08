import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkIssueImport } from "../../../src/doctor/issue-checks";
import { createIssueLandCommenter } from "../../../src/issues/issue-comment";
import { createEmptyIssueSyncState } from "../../../src/issues/issue-state";
import { createFakeGitHub } from "../../utilities/fake-github";
import { createCard } from "../../utilities/workspace-state-store";

const REMOTES = [{ name: "origin", url: "https://github.com/vombor/kanban.git" }];
const ISSUE = { provider: "github" as const, repo: "vombor/kanban", number: 12, url: "u", updatedAt: "t" };

function commenter(config: unknown, github = createFakeGitHub()) {
	return {
		github,
		comment: createIssueLandCommenter({
			readConfig: async () => parsePipelineConfig(config),
			listRemotes: async () => REMOTES,
			resolveAuth: async () => ({ source: "GITHUB_TOKEN", token: "secret-token" }),
			fetch: github.fetch,
		}),
	};
}

describe("issues.commentOnLand", () => {
	const input = {
		workspaceId: "ws-1",
		workspacePath: "/repo",
		card: createCard({ id: "abc12", issue: ISSUE }),
		outcome: "landed" as const,
		baseRef: "main",
		commit: "0123456789abcdef",
	};

	it("comments on the issue when the card lands", async () => {
		const { github, comment } = commenter({
			workspaces: { "ws-1": { issues: { mode: "on", commentOnLand: true } } },
		});
		const done = await comment(input);
		expect(done).toBe("commented on vombor/kanban#12 (landed, via GITHUB_TOKEN)");
		expect(github.requests).toHaveLength(1);
		expect(github.requests[0]?.method).toBe("POST");
		expect(github.requests[0]?.url).toBe("https://api.github.com/repos/vombor/kanban/issues/12/comments");
		expect(JSON.parse(github.requests[0]?.body ?? "{}").body).toContain("Kanban landed card `abc12` onto `main`");
		expect(done).not.toContain("secret-token");
	});

	it("is off by default and never comments on another repository", async () => {
		const off = commenter({ workspaces: { "ws-1": { issues: { mode: "on" } } } });
		expect(await off.comment(input)).toBeNull();
		expect(off.github.requests).toHaveLength(0);

		const other = commenter({ workspaces: { "ws-1": { issues: { mode: "on", commentOnLand: true } } } });
		expect(
			await other.comment({ ...input, card: createCard({ id: "x", issue: { ...ISSUE, repo: "else/where" } }) }),
		).toBeNull();
		expect(other.github.requests).toHaveLength(0);
	});
});

describe("doctor issue rows", () => {
	const entries = [{ workspaceId: "ws-1", repoPath: "/repo" }] as never;

	it("says nothing while every project has issue import off", async () => {
		const findings = await checkIssueImport(parsePipelineConfig({}).config, entries, {
			listRemotes: async () => REMOTES,
			readState: async () => createEmptyIssueSyncState(),
			authSource: async () => {
				throw new Error("must not be asked");
			},
		});
		expect(findings).toEqual([]);
	});

	it("reports mode, repo, auth source, last sync and skipped counts, and the watchdog requirement", async () => {
		const state = createEmptyIssueSyncState();
		state.lastSync = {
			at: "2026-10-07T12:00:00Z",
			ok: true,
			mode: "on",
			repo: "vombor/kanban",
			authSource: "gh",
			summary: "create 1",
			error: null,
			created: 1,
			updated: 0,
			closed: 0,
			skipped: {},
		};
		state.skipped["github:vombor/kanban#2"] = {
			number: 2,
			title: "x",
			reason: "untrusted-author",
			detail: "d",
			at: "2026-10-07T12:00:00Z",
			updatedAt: "2026-10-07T12:00:00Z",
		};
		const findings = await checkIssueImport(
			parsePipelineConfig({ workspaces: { "ws-1": { issues: { mode: "on" } } } }).config,
			entries,
			{ listRemotes: async () => REMOTES, readState: async () => state, authSource: async () => "gh" },
		);
		expect(findings[0]?.message).toContain("issue import on from github vombor/kanban (origin)");
		expect(findings[0]?.message).toContain("auth gh");
		expect(findings[0]?.message).toContain("last sync 2026-10-07T12:00:00Z ok");
		expect(findings[0]?.message).toContain("skipped 1 (untrusted-author 1)");
		expect(findings[1]).toMatchObject({ level: "warn" });
		expect(findings[1]?.message).toContain("watchdog.mode on");
	});

	it("fails a project whose issues.repo is not one of its remotes", async () => {
		const findings = await checkIssueImport(
			parsePipelineConfig({ workspaces: { "ws-1": { issues: { mode: "report", repo: "other/repo" } } } }).config,
			entries,
			{
				listRemotes: async () => REMOTES,
				readState: async () => createEmptyIssueSyncState(),
				authSource: async () => "anonymous",
			},
		);
		expect(findings[0]).toMatchObject({ level: "fail" });
	});

	it("fails a project whose state file can't be read, or whose origin no longer matches the pin", async () => {
		const config = parsePipelineConfig({ workspaces: { "ws-1": { issues: { mode: "on" } } } }).config;
		const corrupt = await checkIssueImport(config, entries, {
			listRemotes: async () => REMOTES,
			readState: async () => {
				throw new Error("issues-state.json can't be read");
			},
			authSource: async () => "gh",
		});
		expect(corrupt[0]).toMatchObject({ level: "fail" });
		expect(corrupt[0]?.message).toContain("can't be read");

		const pinned = createEmptyIssueSyncState();
		pinned.pinnedRepo = { provider: "github", repo: "vombor/kanban", at: "t", source: "origin" };
		const moved = await checkIssueImport(config, entries, {
			listRemotes: async () => [{ name: "origin", url: "git@github.com:attacker/bait.git" }],
			readState: async () => pinned,
			authSource: async () => "gh",
		});
		expect(moved[0]).toMatchObject({ level: "fail" });
		expect(moved[0]?.message).toContain("pinned to vombor/kanban");
	});
});
