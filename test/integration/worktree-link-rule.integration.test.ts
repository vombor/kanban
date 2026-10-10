import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readPipelineConfig, updateWorkspacePipelineEntry } from "../../src/config/pipeline-config";
import { checkWorktreeLinks } from "../../src/doctor/worktree-link-checks";
import { loadKitCatalog } from "../../src/kits/resolve-kit";
import { runProjectUnlinkIgnored } from "../../src/projects/project-unlink-ignored";
import type { ProcessEntry } from "../../src/server/process-table";
import { listWorkspaceIndexEntries, loadWorkspaceContext } from "../../src/state/workspace-state";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { loadWorktreeLinkRule } from "../../src/workspace/worktree-link-rule";
import { createGitTestEnv } from "../utilities/git-env";
import { withTemporaryKanbanHome } from "../utilities/kanban-home";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

/** foo's shape (issue #19): Prisma SQLite files, a Next build, an API build, node_modules and an .env. */
function createFooLikeRepo(sandboxRoot: string): string {
	const repoPath = join(sandboxRoot, "repo");
	mkdirSync(join(repoPath, "prisma"), { recursive: true });
	mkdirSync(join(repoPath, "server"), { recursive: true });
	runGit(repoPath, ["init"]);
	writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
	writeFileSync(join(repoPath, "prisma", "schema.prisma"), "// schema\n", "utf8");
	writeFileSync(join(repoPath, "server", "index.ts"), "export {};\n", "utf8");
	writeFileSync(
		join(repoPath, ".gitignore"),
		["*.db", "*.db-journal", "/.next/", "/server/dist/", "/node_modules/", ".env", "tsconfig.tsbuildinfo", ""].join(
			"\n",
		),
		"utf8",
	);
	runGit(repoPath, ["add", "."]);
	runGit(repoPath, ["commit", "-m", "init"]);
	writeFileSync(join(repoPath, "prisma", "dev.db"), "main dev data", "utf8");
	writeFileSync(join(repoPath, "prisma", "test.db"), "main test data", "utf8");
	mkdirSync(join(repoPath, ".next"), { recursive: true });
	writeFileSync(join(repoPath, ".next", "BUILD_ID"), "main\n", "utf8");
	mkdirSync(join(repoPath, "server", "dist"), { recursive: true });
	writeFileSync(join(repoPath, "server", "dist", "index.js"), "main\n", "utf8");
	mkdirSync(join(repoPath, "node_modules"), { recursive: true });
	writeFileSync(join(repoPath, "node_modules", "package.json"), "{}\n", "utf8");
	writeFileSync(join(repoPath, ".env"), "DATABASE_URL=file:./dev.db\n", "utf8");
	writeFileSync(join(repoPath, "tsconfig.tsbuildinfo"), "{}\n", "utf8");
	return repoPath;
}

async function ensureWorktree(repoPath: string, taskId: string): Promise<string> {
	const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: "HEAD" });
	if (!ensured.ok || !ensured.path) {
		throw new Error(`worktree not created: ${ensured.error}`);
	}
	return ensured.path;
}

function isLink(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

async function setOverrides(workspaceId: string, overrides: Record<string, unknown>): Promise<void> {
	await updateWorkspacePipelineEntry(workspaceId, (entry) => ({ ...entry, kit: { name: "default", overrides } }));
}

/** An old worktree: every candidate linked, as before issue #19. */
function linkLikeBefore(repoPath: string, worktreePath: string, relativePaths: string[]): void {
	for (const relativePath of relativePaths) {
		const linkPath = join(worktreePath, relativePath);
		if (existsSync(linkPath) || isLink(linkPath)) {
			unlinkSync(linkPath);
		}
		mkdirSync(join(linkPath, ".."), { recursive: true });
		symlinkSync(join(repoPath, relativePath), linkPath);
	}
}

function processIn(cwd: string): ProcessEntry {
	return {
		pid: 4242,
		ppid: 1,
		state: "S",
		startTime: "1",
		kernelThread: false,
		command: "node next dev",
		cwd,
		cwdDeleted: false,
		exe: "/usr/bin/node",
		exeDeleted: false,
		rssBytes: 0,
	};
}

describe.skipIf(process.platform === "win32").sequential("worktree link rule (issue #19)", () => {
	it("links .env but no node_modules, database or build output into a new worktree", async () => {
		await withTemporaryKanbanHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-worktree-links-");
			try {
				const repoPath = createFooLikeRepo(sandboxRoot);
				const worktreePath = await ensureWorktree(repoPath, "task-a");

				expect(isLink(join(worktreePath, ".env"))).toBe(true);
				for (const path of [
					"node_modules",
					"prisma/dev.db",
					"prisma/test.db",
					".next",
					"server/dist",
					"tsconfig.tsbuildinfo",
				]) {
					expect(existsSync(join(worktreePath, path)), path).toBe(false);
				}
				// Every candidate stays in the managed exclude block, so an old link never shows in a snapshot.
				expect(runGit(worktreePath, ["status", "--porcelain"])).toBe("");
				const exclude = readFileSync(join(repoPath, ".git", "info", "exclude"), "utf8");
				expect(exclude).toContain("/prisma/dev.db");
				expect(exclude).toContain("/.next");
			} finally {
				cleanup();
			}
		});
	});

	it("follows the project's include/exclude and copies checks.envFile", async () => {
		await withTemporaryKanbanHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-worktree-links-project-");
			try {
				const repoPath = createFooLikeRepo(sandboxRoot);
				const { workspaceId } = await loadWorkspaceContext(repoPath);
				await setOverrides(workspaceId, {
					"worktrees.symlinkIgnored.include": [".next"],
					"worktrees.symlinkIgnored.exclude": ["node_modules"],
					"checks.envFile": ".env",
				});
				const rule = await loadWorktreeLinkRule(workspaceId);
				expect(rule).toEqual({ include: [".next"], exclude: ["node_modules"], copy: [".env"] });

				const worktreePath = await ensureWorktree(repoPath, "task-b");
				expect(isLink(join(worktreePath, ".next"))).toBe(true);
				expect(existsSync(join(worktreePath, "node_modules"))).toBe(false);
				expect(isLink(join(worktreePath, ".env"))).toBe(false);
				expect(readFileSync(join(worktreePath, ".env"), "utf8")).toBe("DATABASE_URL=file:./dev.db\n");

				// The card's own edit survives the next launch.
				writeFileSync(join(worktreePath, ".env"), "DATABASE_URL=file:./card.db\n", "utf8");
				await ensureWorktree(repoPath, "task-b");
				expect(readFileSync(join(worktreePath, ".env"), "utf8")).toBe("DATABASE_URL=file:./card.db\n");
				expect(readFileSync(join(repoPath, ".env"), "utf8")).toBe("DATABASE_URL=file:./dev.db\n");
			} finally {
				cleanup();
			}
		});
	});

	it("keeps an old worktree's links, reports them in doctor and replaces them only where nothing runs", async () => {
		await withTemporaryKanbanHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-worktree-links-old-");
			try {
				const repoPath = createFooLikeRepo(sandboxRoot);
				const { workspaceId } = await loadWorkspaceContext(repoPath);
				const oldPaths = ["prisma/dev.db", "prisma/test.db", ".next", "server/dist"];
				const busyPath = await ensureWorktree(repoPath, "task-busy");
				const idlePath = await ensureWorktree(repoPath, "task-idle");
				linkLikeBefore(repoPath, busyPath, oldPaths);
				linkLikeBefore(repoPath, idlePath, oldPaths);

				// A new launch of an old worktree doesn't remove its links.
				await ensureWorktree(repoPath, "task-busy");
				for (const path of oldPaths) {
					expect(isLink(join(busyPath, path)), path).toBe(true);
				}
				expect(runGit(busyPath, ["status", "--porcelain"])).toBe("");

				const { config } = await readPipelineConfig();
				const entries = (await listWorkspaceIndexEntries()).filter((entry) => entry.workspaceId === workspaceId);
				const findings = await checkWorktreeLinks({ config, catalog: await loadKitCatalog(), entries });
				expect(findings).toHaveLength(1);
				expect(findings[0]?.level).toBe("warn");
				expect(findings[0]?.message).toContain("8 link(s)");
				expect(findings[0]?.message).toContain(`${busyPath}/prisma/dev.db → ${join(repoPath, "prisma", "dev.db")}`);
				expect(findings[0]?.message).toContain(`${idlePath}/server/dist`);
				expect(findings[0]?.hint).toContain("kanban project unlink-ignored");
				expect(findings[0]?.fix).toBeUndefined();

				const rule = await loadWorktreeLinkRule(workspaceId);
				const dryRun = await runProjectUnlinkIgnored({
					repoPath,
					rule,
					dryRun: true,
					listProcesses: async () => [],
					selfPid: process.pid,
				});
				expect(dryRun.map((result) => result.status)).toEqual(["would_replace", "would_replace"]);
				expect(isLink(join(idlePath, ".next"))).toBe(true);

				const results = await runProjectUnlinkIgnored({
					repoPath,
					rule,
					dryRun: false,
					listProcesses: async () => [processIn(join(busyPath, "server"))],
					selfPid: process.pid,
				});
				const byPath = new Map(results.map((result) => [result.worktreePath, result]));
				expect(byPath.get(busyPath)?.status).toBe("skipped");
				expect(byPath.get(busyPath)?.detail).toContain("pid 4242");
				expect(byPath.get(idlePath)?.status).toBe("replaced");
				for (const path of oldPaths) {
					expect(isLink(join(busyPath, path)), path).toBe(true);
					expect(isLink(join(idlePath, path)), path).toBe(false);
				}
				expect(readFileSync(join(idlePath, "prisma", "dev.db"), "utf8")).toBe("main dev data");
				expect(lstatSync(join(idlePath, ".next")).isDirectory()).toBe(true);
				expect(existsSync(join(idlePath, ".next", "BUILD_ID"))).toBe(false);
				// The main checkout's files are untouched.
				expect(readFileSync(join(repoPath, ".next", "BUILD_ID"), "utf8")).toBe("main\n");
				expect(readFileSync(join(repoPath, "prisma", "dev.db"), "utf8")).toBe("main dev data");
				expect(runGit(idlePath, ["status", "--porcelain"])).toBe("");

				// .env is still the rule's link, so it is not reported.
				const after = await checkWorktreeLinks({ config, catalog: await loadKitCatalog(), entries });
				expect(after[0]?.message).toContain("4 link(s) to the main checkout in 1 task worktree(s)");
				expect(after[0]?.message).not.toContain("node_modules");
			} finally {
				cleanup();
			}
		});
	});
});
