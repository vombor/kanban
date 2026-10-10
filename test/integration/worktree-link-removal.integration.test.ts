// Issue #19: nothing that removes or cleans a task worktree may reach the main checkout through a link Kanban made.
// foo's tools/preview/node_modules (a nested link) was emptied by each card's `npm ci`, which deletes every entry of
// node_modules through the link before replacing the link with a directory; so installed packages aren't linked by
// default any more. These tests link root and nested files and directories on purpose (the project's `include`) and
// run every path that deletes or cleans a worktree.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { updateWorkspacePipelineEntry } from "../../src/config/pipeline-config";
import { cleanGeneratedReports } from "../../src/pipeline/recovery-runtime";
import { runProjectUnlinkIgnored } from "../../src/projects/project-unlink-ignored";
import { loadWorkspaceContext } from "../../src/state/workspace-state";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { loadWorktreeLinkRule } from "../../src/workspace/worktree-link-rule";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import { createTempDir } from "../utilities/temp-dir";

/** The main checkout's ignored files, root and nested, in files and directories. */
const MAIN_FILES: Record<string, string> = {
	"node_modules/root-pkg/index.js": "root package\n",
	"tools/preview/node_modules/@axe-core/playwright/index.js": "axe\n",
	"tools/preview/node_modules/playwright/package.json": "{}\n",
	".env": "SECRET=main\n",
	"prisma/dev.db": "main dev data",
	"coverage/lcov.info": "main coverage\n",
};

/** The links each worktree gets with the project's include below. */
const LINKED_PATHS = ["node_modules", "tools/preview/node_modules", ".env", "prisma/dev.db", "coverage"];
const INCLUDE = ["node_modules", "*.db", "coverage"];

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

function createRepo(sandboxRoot: string): string {
	const repoPath = join(sandboxRoot, "repo");
	mkdirSync(join(repoPath, "tools", "preview"), { recursive: true });
	mkdirSync(join(repoPath, "prisma"), { recursive: true });
	runGit(repoPath, ["init"]);
	writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n.env\n*.db\ncoverage/\n", "utf8");
	writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
	writeFileSync(join(repoPath, "prisma", "schema.prisma"), "// schema\n", "utf8");
	writeFileSync(join(repoPath, "tools", "preview", "package.json"), '{"name":"preview","version":"1.0.0"}\n');
	writeFileSync(
		join(repoPath, "tools", "preview", "package-lock.json"),
		`${JSON.stringify({
			name: "preview",
			version: "1.0.0",
			lockfileVersion: 3,
			requires: true,
			packages: { "": { name: "preview", version: "1.0.0" } },
		})}\n`,
	);
	runGit(repoPath, ["add", "."]);
	runGit(repoPath, ["commit", "-m", "init"]);
	for (const [relativePath, content] of Object.entries(MAIN_FILES)) {
		mkdirSync(join(repoPath, relativePath, ".."), { recursive: true });
		writeFileSync(join(repoPath, relativePath), content, "utf8");
	}
	return repoPath;
}

function expectMainCheckoutIntact(repoPath: string): void {
	for (const [relativePath, content] of Object.entries(MAIN_FILES)) {
		expect(existsSync(join(repoPath, relativePath)), relativePath).toBe(true);
		expect(readFileSync(join(repoPath, relativePath), "utf8"), relativePath).toBe(content);
	}
}

function isLink(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

async function includeLinks(repoPath: string, include: string[]): Promise<string> {
	const { workspaceId } = await loadWorkspaceContext(repoPath);
	await updateWorkspacePipelineEntry(workspaceId, (entry) => ({
		...entry,
		kit: { name: "default", overrides: { "worktrees.symlinkIgnored.include": include } },
	}));
	return workspaceId;
}

async function ensureWorktree(repoPath: string, taskId: string): Promise<string> {
	const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: "HEAD" });
	if (!ensured.ok || !ensured.path) {
		throw new Error(`worktree not created: ${ensured.error}`);
	}
	return ensured.path;
}

/** A linked worktree whose git can't find its repository, so neither git nor the managed block names its links. */
function breakWorktreeGit(worktreePath: string): void {
	writeFileSync(join(worktreePath, ".git"), "gitdir: /nonexistent/kanban-test-gitdir\n", "utf8");
}

async function withLinkedRepo(
	prefix: string,
	run: (input: { repoPath: string; worktreePath: string; workspaceId: string }) => Promise<void>,
): Promise<void> {
	await withTemporaryKanbanHome(async () => {
		const { path: sandboxRoot, cleanup } = createTempDir(prefix);
		try {
			const repoPath = createRepo(sandboxRoot);
			const workspaceId = await includeLinks(repoPath, INCLUDE);
			const worktreePath = await ensureWorktree(repoPath, "task-linked");
			for (const path of LINKED_PATHS) {
				expect(isLink(join(worktreePath, path)), path).toBe(true);
			}
			await run({ repoPath, worktreePath, workspaceId });
		} finally {
			cleanup();
		}
	});
}

describe.skipIf(process.platform === "win32").sequential("worktree removal never deletes through a link", () => {
	it("Done's worktree delete (patch capture, then removal) unlinks root and nested links, files and dirs", async () => {
		await withLinkedRepo("kanban-link-removal-delete-", async ({ repoPath, worktreePath }) => {
			// A link the agent made, outside Kanban's managed block, to a main checkout directory.
			mkdirSync(join(worktreePath, "scratch"), { recursive: true });
			symlinkSync(join(repoPath, "tools", "preview", "node_modules"), join(worktreePath, "scratch", "deps"));
			writeFileSync(join(worktreePath, "card-work.txt"), "work\n", "utf8");

			const deleted = await deleteTaskWorktree({ repoPath, taskId: "task-linked" });

			expect(deleted).toEqual({ ok: true, removed: true });
			expect(existsSync(worktreePath)).toBe(false);
			expectMainCheckoutIntact(repoPath);
		});
	});

	it("removes a worktree git can't remove without following its links", async () => {
		await withLinkedRepo("kanban-link-removal-broken-", async ({ repoPath, worktreePath }) => {
			breakWorktreeGit(worktreePath);

			const deleted = await deleteTaskWorktree({ repoPath, taskId: "task-linked" });

			expect(deleted.ok).toBe(true);
			expect(existsSync(worktreePath)).toBe(false);
			expectMainCheckoutIntact(repoPath);
		});
	});

	it("recreates a broken worktree on the next launch without following its links", async () => {
		await withLinkedRepo("kanban-link-removal-recreate-", async ({ repoPath, worktreePath }) => {
			breakWorktreeGit(worktreePath);

			const recreated = await ensureWorktree(repoPath, "task-linked");

			expect(recreated).toBe(worktreePath);
			expect(runGit(recreated, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
			expectMainCheckoutIntact(repoPath);
		});
	});

	it("recovery's generated-report cleanup (git clean -X) drops a linked report dir, not its target", async () => {
		await withLinkedRepo("kanban-link-removal-clean-", async ({ repoPath, worktreePath }) => {
			expect(await cleanGeneratedReports(worktreePath)).toEqual(["coverage"]);

			expect(existsSync(join(worktreePath, "coverage"))).toBe(false);
			expectMainCheckoutIntact(repoPath);
		});
	});

	it("unlink-ignored replaces a nested node_modules link with an empty directory", async () => {
		await withLinkedRepo("kanban-link-removal-unlink-", async ({ repoPath, worktreePath, workspaceId }) => {
			await includeLinks(repoPath, []);

			const results = await runProjectUnlinkIgnored({
				repoPath,
				rule: await loadWorktreeLinkRule(workspaceId),
				dryRun: false,
				listProcesses: async () => [],
				selfPid: process.pid,
			});

			expect(results.map((result) => result.status)).toEqual(["replaced"]);
			for (const path of ["node_modules", "tools/preview/node_modules", "coverage"]) {
				expect(isLink(join(worktreePath, path)), path).toBe(false);
				expect(lstatSync(join(worktreePath, path)).isDirectory(), path).toBe(true);
			}
			expect(readFileSync(join(worktreePath, "prisma", "dev.db"), "utf8")).toBe("main dev data");
			expectMainCheckoutIntact(repoPath);
		});
	});

	it("a card's npm ci in a nested package leaves the main checkout's node_modules alone by default", async () => {
		await withTemporaryKanbanHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-link-removal-npm-");
			try {
				const repoPath = createRepo(sandboxRoot);
				const worktreePath = await ensureWorktree(repoPath, "task-npm");
				expect(existsSync(join(worktreePath, "tools", "preview", "node_modules"))).toBe(false);
				expect(existsSync(join(worktreePath, "node_modules"))).toBe(false);

				const env = Object.fromEntries(
					Object.entries(createGitTestEnv()).filter(
						([name]) => !name.startsWith("npm_") && !name.startsWith("KANBAN_"),
					),
				);
				const install = spawnSync("npm", ["ci", "--offline", "--no-audit", "--no-fund"], {
					cwd: join(worktreePath, "tools", "preview"),
					encoding: "utf8",
					env,
				});

				expect(install.status, install.stderr).toBe(0);
				expectMainCheckoutIntact(repoPath);
			} finally {
				cleanup();
			}
		});
	});
});
