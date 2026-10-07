import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_GUARDRAIL_DENY_COMMANDS } from "../../../src/config/pipeline-config";
import { parseDeniedCommandPatterns } from "../../../src/guardrails/command-patterns";
import type { TaskGuardrails } from "../../../src/guardrails/task-guardrails";
import { takeTaskSnapshot } from "../../../src/pipeline/snapshots";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { landCommit } from "../../../src/workspace/land";
import { createLandRepo } from "../../utilities/land-repo";

// The PreToolUse hook embeds the card's guard policy (absolute paths, base64), so Kanban's .cline/hooks files must
// never land with the card's work: they are git-excluded like .github/hooks/kanban.json.
describe("Cline hooks in a card's worktree", () => {
	const originalHome = process.env.HOME;
	let home: string;
	let repo: ReturnType<typeof createLandRepo>;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kanban-cline-hooks-home-"));
		process.env.HOME = home;
		repo = createLandRepo();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		repo.cleanup();
		rmSync(home, { recursive: true, force: true });
	});

	function guardrailsFor(worktreePath: string): TaskGuardrails {
		return {
			worktreePath,
			projectPath: repo.repoPath,
			protectedDirs: [repo.repoPath],
			confineWrites: true,
			gitCommonDir: join(repo.repoPath, ".git"),
			tempDirs: ["/tmp"],
			linkedDirs: [],
			extraWritableDirs: [],
			sharedBranches: ["main"],
			deniedCommands: parseDeniedCommandPatterns(DEFAULT_GUARDRAIL_DENY_COMMANDS, ["main"]),
			ownBranchPush: false,
		};
	}

	it("leaves them out of the card's snapshot and of what lands", async () => {
		const worktree = repo.addWorktree("card-1");
		await prepareAgentLaunch({
			taskId: "card-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: worktree,
			prompt: "Fix the bug",
			workspaceId: "workspace-1",
			guardrails: guardrailsFor(worktree),
		});
		expect(existsSync(join(worktree, ".cline", "hooks", "PreToolUse"))).toBe(true);
		repo.write(worktree, "src/app.ts", "export const value = 2;\n");
		expect(repo.git(["status", "--porcelain", "--untracked-files=all"], worktree)).toBe("M src/app.ts");

		const snapshot = await takeTaskSnapshot({
			worktreePath: worktree,
			taskId: "card-1",
			baseRef: "main",
			reason: "review",
			dryRun: false,
		});
		expect(repo.git(["ls-tree", "-r", "--name-only", snapshot.commit])).toBe("README.md\nsrc/app.ts");

		const landed = await landCommit({
			repoPath: repo.repoPath,
			baseRef: "main",
			commit: snapshot.commit,
			message: { title: "Fix the bug", body: "card-1" },
			taskId: "card-1",
		});
		expect(landed.status).toBe("landed");
		expect(repo.git(["ls-tree", "-r", "--name-only", repo.tip()])).toBe("README.md\nsrc/app.ts");
		expect(existsSync(join(repo.repoPath, ".cline"))).toBe(false);
	});
});
