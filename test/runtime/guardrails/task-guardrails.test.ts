import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { findDeniedCommand, PLAN_APPROVAL_DENY_COMMANDS } from "../../../src/guardrails/command-patterns";
import {
	buildGuardrailPromptNote,
	listGuardrailWritableRoots,
	listMatcherDeniedCommands,
	resolveOrchestratorGuardrails,
	resolveTaskGuardrails,
} from "../../../src/guardrails/task-guardrails";
import { createGitTestEnv } from "../../utilities/git-env";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
}

describe("task guardrails", () => {
	let root: string;
	let repo: string;
	let worktree: string;
	let otherWorktree: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "kanban-guardrails-")));
		repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
		mkdirSync(join(repo, "node_modules"));
		worktree = join(root, "worktrees", "card-1", "repo");
		otherWorktree = join(root, "worktrees", "card-2", "repo");
		git(repo, "worktree", "add", "-q", worktree, "-b", "card-1");
		git(repo, "worktree", "add", "-q", otherWorktree, "-b", "card-2");
		// What task-worktree.ts does for ignored paths: a symlink plus a managed exclude block.
		symlinkSync(join(repo, "node_modules"), join(worktree, "node_modules"));
		writeFileSync(
			join(repo, ".git", "info", "exclude"),
			"# kanban-managed-symlinked-ignored-paths:start\n# Keep symlinked ignored paths ignored inside Kanban task worktrees.\n/node_modules\n# kanban-managed-symlinked-ignored-paths:end\n",
		);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("lets a card launched with the PR git action push its own branch, unless prCardPush is deny", async () => {
		const resolve = async (raw: unknown, gitAction: "commit" | "pr" | null) =>
			await resolveTaskGuardrails({
				config: parsePipelineConfig(raw).config,
				taskId: "card-1",
				workspaceId: "ws",
				worktreePath: worktree,
				projectPath: repo,
				baseRef: "fork/stack",
				gitAction,
			});
		const pr = await resolve({}, "pr");
		expect(pr?.ownBranchPush).toBe(true);
		// CLI-native deny lists keep the plain rule; Kanban's matcher gets the own-branch one.
		expect(pr?.deniedCommands.map((rule) => rule.pattern)).toContain("git push");
		const matcherRules = pr ? listMatcherDeniedCommands(pr) : [];
		const sharedPush = matcherRules.find((rule) => rule.sharedPush);
		expect(sharedPush?.pattern).toBe("git push {shared-push}");
		expect(sharedPush?.sharedPush).toEqual(["main", "master", "fork/stack"]);
		expect(matcherRules.map((rule) => rule.pattern)).not.toContain("git push");
		expect((await resolve({}, "commit"))?.ownBranchPush).toBe(false);
		expect((await resolve({}, null))?.ownBranchPush).toBe(false);
		expect((await resolve({ guardrails: { prCardPush: "deny" } }, "pr"))?.ownBranchPush).toBe(false);
		const commit = await resolve({}, "commit");
		expect(commit ? listMatcherDeniedCommands(commit) : null).toBe(commit?.deniedCommands);
	});

	it("resolves a card's writable dirs, protected dirs, shared branches and denied commands", async () => {
		const { config } = parsePipelineConfig({
			guardrails: { extraWritableDirs: ["/opt/cache"] },
			workspaces: { ws: { defaultBaseRef: "fork/stack", guardrails: { extraDenyCommands: ["npm publish"] } } },
		});
		const guardrails = await resolveTaskGuardrails({
			config,
			taskId: "card-1",
			workspaceId: "ws",
			worktreePath: worktree,
			projectPath: repo,
			baseRef: "origin/release",
		});
		expect(guardrails).not.toBeNull();
		if (!guardrails) {
			return;
		}
		expect(guardrails.worktreePath).toBe(worktree);
		expect(guardrails.gitCommonDir).toBe(join(repo, ".git"));
		expect(guardrails.linkedDirs).toEqual([join(repo, "node_modules")]);
		expect(guardrails.extraWritableDirs).toEqual(["/opt/cache"]);
		expect(guardrails.tempDirs).toContain(tmpdir());
		// The main checkout and the other card's worktree, never the card's own.
		expect(guardrails.protectedDirs.sort()).toEqual([otherWorktree, repo].sort());
		expect(guardrails.sharedBranches).toEqual(["main", "master", "fork/stack", "release"]);
		expect(guardrails.deniedCommands.map((rule) => rule.pattern)).toContain("git push");
		expect(guardrails.deniedCommands.map((rule) => rule.pattern)).toContain("npm publish");
		expect(listGuardrailWritableRoots(guardrails)[0]).toBe(worktree);
		expect(listGuardrailWritableRoots(guardrails)).toContain(join(repo, ".git"));

		const note = buildGuardrailPromptNote(guardrails, ["shell commands that write outside the worktree"]);
		expect(note).toContain(`Write only inside your worktree ${worktree}`);
		expect(note).toContain("git branch -D|-d|--delete|-f|--force|-m|-M <shared branch>");
		expect(note).toContain("Shared branches: main, master, fork/stack, release.");
		expect(note).toContain("Not blocked for you (shell commands that write outside the worktree)");
	});

	it("gives the orchestrator's sessions no guardrails", async () => {
		const { config } = parsePipelineConfig({});
		for (const taskId of ["__home_agent__:ws:claude", "__home_agent__:ws:copilot"]) {
			expect(
				await resolveTaskGuardrails({ config, taskId, workspaceId: "ws", worktreePath: repo, projectPath: repo }),
			).toBeNull();
		}
	});

	it("denies every card and the orchestrator's isolation guardrails the plan approval, whatever denyCommands says", async () => {
		const input = { taskId: "card-1", workspaceId: "ws", worktreePath: worktree, projectPath: repo };
		// A config that replaces the default denies can't drop the rail.
		const custom = parsePipelineConfig({ guardrails: { denyCommands: ["npm publish"] } }).config;
		const card = await resolveTaskGuardrails({ ...input, config: custom });
		expect(card?.deniedCommands.map((rule) => rule.pattern)).toEqual(["npm publish", ...PLAN_APPROVAL_DENY_COMMANDS]);
		const rules = card ? listMatcherDeniedCommands(card) : [];
		expect(findDeniedCommand("kanban plan approve 1a2b3", rules)?.rule.pattern).toBe("kanban plan approve");
		expect(findDeniedCommand("kanban plan expand 1a2b3 --approved-by-user", rules)?.rule.pattern).toBe(
			"kanban plan expand --approved-by-user",
		);
		// Expanding an approved plan, showing and checking one stay allowed.
		expect(findDeniedCommand("kanban plan expand 1a2b3", rules)).toBeNull();
		expect(findDeniedCommand("kanban plan check --file docs/specs/x.cards.json", rules)).toBeNull();
		expect(buildGuardrailPromptNote(card ?? never(), ["commands"])).toContain(
			"kanban plan approve; kanban plan expand --approved-by-user",
		);

		const isolation = {
			workspaceId: "ws",
			projectPath: repo,
			dataDir: join(root, "data", "ws"),
			deniedDirs: [join(root, "other")],
			machineConfigPaths: [],
			claudeProjectDirs: [],
		};
		const orchestrator = await resolveOrchestratorGuardrails({ projectPath: repo, isolation });
		expect(orchestrator?.deniedCommands.map((rule) => rule.pattern)).toEqual([...PLAN_APPROVAL_DENY_COMMANDS]);
		expect(await resolveOrchestratorGuardrails({ projectPath: repo, isolation: null })).toBeNull();
	});

	it("is off when the machine or the workspace turns it off; the workspace setting wins", async () => {
		const input = { taskId: "card-1", workspaceId: "ws", worktreePath: worktree, projectPath: repo };
		const off = parsePipelineConfig({ guardrails: { enabled: false } }).config;
		expect(await resolveTaskGuardrails({ ...input, config: off })).toBeNull();
		const workspaceOff = parsePipelineConfig({ workspaces: { ws: { guardrails: { enabled: false } } } }).config;
		expect(await resolveTaskGuardrails({ ...input, config: workspaceOff })).toBeNull();
		const workspaceOn = parsePipelineConfig({
			guardrails: { enabled: false },
			workspaces: { ws: { guardrails: { enabled: true } } },
		}).config;
		expect(await resolveTaskGuardrails({ ...input, config: workspaceOn })).not.toBeNull();
	});
});

function never(): never {
	throw new Error("expected guardrails");
}
