import { describe, expect, it } from "vitest";

import { workspaceIssuesSettingsSchema } from "../../../src/config/pipeline-config";
import type { ProviderIssue } from "../../../src/issues/issue-provider";
import { parseGitRemoteUrl, resolveIssueRepo } from "../../../src/issues/issue-repo";
import { evaluateIssueTrust } from "../../../src/issues/issue-trust";

const filter = workspaceIssuesSettingsSchema.parse({}).filter;

function issue(overrides: Partial<ProviderIssue> = {}): ProviderIssue {
	return {
		number: 1,
		title: "A bug",
		body: "",
		url: "https://github.com/vombor/kanban/issues/1",
		state: "open",
		author: "alice",
		authorAssociation: "OWNER",
		labels: [],
		createdAt: "2026-10-01T00:00:00Z",
		updatedAt: "2026-10-01T00:00:00Z",
		closedAt: null,
		commentCount: 0,
		isPullRequest: false,
		...overrides,
	};
}

describe("parseGitRemoteUrl", () => {
	it.each([
		["git@github.com:vombor/kanban.git", "vombor/kanban"],
		["git@github.com:vombor/kanban", "vombor/kanban"],
		["ssh://git@github.com/vombor/kanban.git", "vombor/kanban"],
		["ssh://git@ssh.github.com:443/vombor/kanban.git", "vombor/kanban"],
		["https://github.com/vombor/kanban.git", "vombor/kanban"],
		["https://github.com/vombor/kanban/", "vombor/kanban"],
		["https://token@github.com/vombor/kanban", "vombor/kanban"],
		["git://github.com/vombor/kanban.git", "vombor/kanban"],
	])("reads %s", (url, repo) => {
		expect(parseGitRemoteUrl(url)?.repo).toBe(repo);
	});

	it("rejects local paths and other shapes", () => {
		expect(parseGitRemoteUrl("/srv/git/kanban.git")).toBeNull();
		expect(parseGitRemoteUrl("https://github.com/vombor")).toBeNull();
		expect(parseGitRemoteUrl("https://github.com/a/b/c")).toBeNull();
		expect(parseGitRemoteUrl("file:///srv/git/a/b")).toBeNull();
	});
});

describe("resolveIssueRepo", () => {
	const remotes = [
		{ name: "origin", url: "git@github.com:vombor/kanban.git" },
		{ name: "upstream", url: "https://github.com/cline/kanban.git" },
		{ name: "lab", url: "git@gitlab.com:vombor/other.git" },
	];

	it("derives the repository from origin (ssh form)", () => {
		expect(resolveIssueRepo({ provider: "github", configured: null, remotes })).toEqual({
			ok: true,
			repo: "vombor/kanban",
			remote: "origin",
			source: "origin",
		});
	});

	it("derives it from an https origin", () => {
		const result = resolveIssueRepo({
			provider: "github",
			configured: null,
			remotes: [{ name: "origin", url: "https://github.com/vombor/kanban" }],
		});
		expect(result.ok && result.repo).toBe("vombor/kanban");
	});

	it("accepts a configured repo that is one of the project's remotes", () => {
		const result = resolveIssueRepo({ provider: "github", configured: "Cline/Kanban", remotes });
		expect(result).toMatchObject({ ok: true, repo: "cline/kanban", remote: "upstream", source: "config" });
	});

	it("refuses a repo that is not one of the project's remotes", () => {
		const result = resolveIssueRepo({ provider: "github", configured: "someone/else", remotes });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("not one of this project's github remotes");
	});

	it("refuses a repo on another host, even with the same path", () => {
		expect(resolveIssueRepo({ provider: "github", configured: "vombor/other", remotes }).ok).toBe(false);
	});

	it("fails when origin is not on GitHub", () => {
		const result = resolveIssueRepo({
			provider: "github",
			configured: null,
			remotes: [{ name: "origin", url: "git@gitlab.com:vombor/other.git" }],
		});
		expect(result.ok).toBe(false);
	});
});

describe("evaluateIssueTrust", () => {
	it("imports an OWNER's issue", () => {
		expect(evaluateIssueTrust(issue(), filter)).toMatchObject({ import: true, via: "author" });
	});

	it("imports MEMBER and COLLABORATOR issues", () => {
		expect(evaluateIssueTrust(issue({ authorAssociation: "MEMBER" }), filter).import).toBe(true);
		expect(evaluateIssueTrust(issue({ authorAssociation: "COLLABORATOR" }), filter).import).toBe(true);
	});

	it("skips a NONE author's issue without the kanban label", () => {
		expect(evaluateIssueTrust(issue({ authorAssociation: "NONE" }), filter)).toMatchObject({
			import: false,
			reason: "untrusted-author",
		});
		expect(evaluateIssueTrust(issue({ authorAssociation: "CONTRIBUTOR" }), filter).import).toBe(false);
	});

	it("imports a NONE author's issue that carries the kanban label", () => {
		expect(evaluateIssueTrust(issue({ authorAssociation: "NONE", labels: ["Kanban"] }), filter)).toMatchObject({
			import: true,
			via: "label",
		});
	});

	it("never imports pull requests or closed issues", () => {
		expect(evaluateIssueTrust(issue({ isPullRequest: true }), filter)).toMatchObject({ reason: "pull-request" });
		expect(evaluateIssueTrust(issue({ state: "closed" }), filter)).toMatchObject({ reason: "closed" });
	});

	it("lets exclude labels win and include labels narrow", () => {
		const custom = { ...filter, excludeLabels: ["wontfix"], includeLabels: ["bug"] };
		expect(evaluateIssueTrust(issue({ labels: ["bug", "wontfix"] }), custom)).toMatchObject({
			reason: "excluded-label",
		});
		expect(evaluateIssueTrust(issue({ labels: ["docs"] }), custom)).toMatchObject({
			reason: "missing-include-label",
		});
		expect(evaluateIssueTrust(issue({ labels: ["bug"] }), custom).import).toBe(true);
	});

	it("trusts only the configured associations", () => {
		const ownerOnly = { ...filter, trustedAssociations: ["OWNER"], trustLabels: [] };
		expect(evaluateIssueTrust(issue({ authorAssociation: "MEMBER" }), ownerOnly).import).toBe(false);
	});
});
