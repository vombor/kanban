import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
	ensureClaudeWorkspaceTrusted,
	getClaudeConfigFilePath,
	getClaudeWorkspaceTrustConfirmInput,
	hasClaudeWorkspaceTrustPrompt,
	isClaudeWorkspaceTrusted,
	shouldAutoConfirmClaudeWorkspaceTrust,
} from "../../../src/terminal/claude-workspace-trust";
import { resolveWorkspaceTrustRoot } from "../../../src/terminal/workspace-trust-root";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

// Claude Code 2.1.291 trust dialog as Ink writes it to the PTY: words placed with cursor moves, and
// "No, exit" listed first with the pointer on it.
const DIALOG_FIRST_RENDER =
	"\u001b[2GAccessing\u001b[12Gworkspace:\r\r\n\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject" +
	"\r\r\n\u001b[2G\u001b]8;id=zaxmda;https://code.claude.com/docs/en/security\u0007\u001b[38;2;153;153;153mSecurity guide\u001b[39m\u001b]8;;\u0007\r\r\n\r\r\n" +
	"\u001b[2G\u001b[38;2;177;185;249m❯\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n" +
	"\u001b[2G\u001b[38;2;153;153;153mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\r\n";
// Re-render after one arrow down.
const DIALOG_AFTER_ARROW_DOWN =
	"\u001b[1C\u001b[4A \u001b[4GNo, exit\r\u001b[1C\u001b[1B\u001b[38;2;177;185;249m❯\u001b[4GYes, I trust this folder\u001b[39m\r\r\n\r\n\r\n";

let root = "";
let repo = "";
let worktree = "";
let plainDir = "";

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: createGitTestEnv() });
	expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

function writeConfig(name: string, content: unknown, mode = 0o600): string {
	const filePath = join(root, name);
	writeFileSync(filePath, JSON.stringify(content, null, 2), { mode });
	return filePath;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kanban-claude-workspace-trust-")));
	repo = join(root, "projects", "app");
	mkdirSync(join(repo, "src"), { recursive: true });
	git(repo, "init", "-q");
	git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
	worktree = join(root, "worktrees", "abcde", "app");
	git(repo, "worktree", "add", "-q", "--detach", worktree);
	mkdirSync(join(worktree, "sub"));
	plainDir = join(root, "plain", "sub");
	mkdirSync(plainDir, { recursive: true });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("workspace trust root", () => {
	it("is the main repo root for a repo, a subdirectory, a worktree and a worktree subdirectory", async () => {
		for (const directory of [repo, join(repo, "src"), worktree, join(worktree, "sub")]) {
			expect(await resolveWorkspaceTrustRoot(directory)).toEqual({ path: repo, isGitRepository: true });
		}
	});

	it("is the directory itself outside git", async () => {
		expect(await resolveWorkspaceTrustRoot(plainDir)).toEqual({ path: plainDir, isGitRepository: false });
	});
});

describe("claude workspace pre-trust", () => {
	it("uses CLAUDE_CONFIG_DIR when set", () => {
		expect(getClaudeConfigFilePath({ CLAUDE_CONFIG_DIR: "/x/cfg" })).toBe("/x/cfg/.claude.json");
		expect(getClaudeConfigFilePath({ HOME: "/home/u" })).toMatch(/\.claude\.json$/u);
	});

	it("sets the main repo key for a worktree and keeps every other key and the file mode", async () => {
		const original = {
			numStartups: 7,
			projects: { [repo]: { allowedTools: ["x"], lastSessionId: "s1" }, "/other": { hasTrustDialogAccepted: true } },
			oauthAccount: { a: 1 },
		};
		const configFilePath = writeConfig("keeps.json", original);
		expect(await isClaudeWorkspaceTrusted(worktree, { configFilePath })).toBe(false);

		expect(await ensureClaudeWorkspaceTrusted(worktree, { configFilePath })).toEqual({
			changed: true,
			trustRootPath: repo,
		});
		expect(JSON.parse(readFileSync(configFilePath, "utf8"))).toEqual({
			...original,
			projects: { ...original.projects, [repo]: { ...original.projects[repo], hasTrustDialogAccepted: true } },
		});
		expect(statSync(configFilePath).mode & 0o777).toBe(0o600);
		expect(await isClaudeWorkspaceTrusted(join(worktree, "sub"), { configFilePath })).toBe(true);
		expect(await ensureClaudeWorkspaceTrusted(repo, { configFilePath })).toEqual({
			changed: false,
			trustRootPath: repo,
		});
		expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("counts a trusted parent outside git but not for a git repo, like Claude Code", async () => {
		const configFilePath = writeConfig("parents.json", {
			projects: {
				[join(root, "plain")]: { hasTrustDialogAccepted: true },
				[join(root, "projects")]: { hasTrustDialogAccepted: true },
			},
		});
		expect(await isClaudeWorkspaceTrusted(plainDir, { configFilePath })).toBe(true);
		expect(await isClaudeWorkspaceTrusted(repo, { configFilePath })).toBe(false);
	});

	it("leaves a missing config file alone", async () => {
		const configFilePath = join(root, "missing", ".claude.json");
		const result = await ensureClaudeWorkspaceTrusted(repo, { configFilePath });
		expect(result.changed).toBe(false);
		expect(result.error).toMatch(/does not exist/u);
		expect(() => statSync(configFilePath)).toThrow();
	});

	it("keeps its key while another process keeps rewriting the file", async () => {
		const configFilePath = writeConfig("concurrent.json", { n: 0, projects: {} });
		// Like a running Claude Code session: read, change, write temp + rename, every few ms.
		const writer = spawn(process.execPath, [
			"-e",
			`const fs=require("fs");const f=${JSON.stringify(configFilePath)};const end=Date.now()+1500;
			(function w(){const d=JSON.parse(fs.readFileSync(f,"utf8"));d.n++;fs.writeFileSync(f+".w",JSON.stringify(d));fs.renameSync(f+".w",f);if(Date.now()<end)setTimeout(w,3)})()`,
		]);
		const writerDone = new Promise((resolveWriter) => writer.on("exit", resolveWriter));
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
		const result = await ensureClaudeWorkspaceTrusted(repo, { configFilePath, attempts: 40, retryDelayMs: () => 20 });
		await writerDone;
		const final = JSON.parse(readFileSync(configFilePath, "utf8")) as {
			n: number;
			projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
		};
		expect(final.n).toBeGreaterThan(10);
		expect(result).toEqual({ changed: true, trustRootPath: repo });
		expect(final.projects[repo]?.hasTrustDialogAccepted).toBe(true);
	});
});

describe("claude workspace pre-trust safety", () => {
	const originalHome = process.env.HOME;

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	});

	it("serialises concurrent calls in this process", async () => {
		const configFilePath = writeConfig("parallel.json", { projects: {} });
		const results = await Promise.all(
			Array.from({ length: 5 }, () => ensureClaudeWorkspaceTrusted(worktree, { configFilePath })),
		);
		expect(results.filter((result) => result.changed)).toHaveLength(1);
		expect(results.every((result) => result.error === undefined)).toBe(true);
		expect(JSON.parse(readFileSync(configFilePath, "utf8"))).toEqual({
			projects: { [repo]: { hasTrustDialogAccepted: true } },
		});
	});

	it("does not pre-trust a non-git directory, the home directory or a filesystem root", async () => {
		const configFilePath = writeConfig("refuse.json", { projects: {} });
		expect((await ensureClaudeWorkspaceTrusted(plainDir, { configFilePath })).error).toMatch(/not inside a git/u);
		expect((await ensureClaudeWorkspaceTrusted("/", { configFilePath })).error).toMatch(/not inside a git|root/u);
		// A home directory that is itself a git repo (dotfiles), seen from the home and from a subfolder.
		process.env.HOME = repo;
		expect((await ensureClaudeWorkspaceTrusted(repo, { configFilePath })).error).toMatch(/home directory/u);
		expect((await ensureClaudeWorkspaceTrusted(join(repo, "src"), { configFilePath })).error).toMatch(
			/home directory/u,
		);
		expect(JSON.parse(readFileSync(configFilePath, "utf8"))).toEqual({ projects: {} });
	});

	it("refuses the home directory through symlinks either way", async () => {
		const configFilePath = writeConfig("refuse-symlink.json", { projects: {} });
		const homeLink = join(root, "homelink");
		symlinkSync(repo, homeLink);
		// cwd reached through a symlink to the real home
		process.env.HOME = repo;
		expect((await ensureClaudeWorkspaceTrusted(homeLink, { configFilePath })).error).toMatch(/home directory/u);
		expect((await ensureClaudeWorkspaceTrusted(join(homeLink, "src"), { configFilePath })).error).toMatch(
			/home directory/u,
		);
		// HOME is a symlink (/home -> /var/home) and the cwd is the real home
		process.env.HOME = homeLink;
		expect((await ensureClaudeWorkspaceTrusted(repo, { configFilePath })).error).toMatch(/home directory/u);
		expect((await ensureClaudeWorkspaceTrusted(join(repo, "src"), { configFilePath })).error).toMatch(
			/home directory/u,
		);
		expect(JSON.parse(readFileSync(configFilePath, "utf8"))).toEqual({ projects: {} });
	});

	it("keys a cwd reached through a symlinked repo or worktree path by the real main repo path", async () => {
		const repoLink = join(root, "repolink");
		const worktreeLink = join(root, "worktreelink");
		symlinkSync(repo, repoLink);
		symlinkSync(worktree, worktreeLink);
		for (const directory of [repoLink, join(repoLink, "src"), worktreeLink, join(worktreeLink, "sub")]) {
			expect(await resolveWorkspaceTrustRoot(directory)).toEqual({ path: repo, isGitRepository: true });
		}
		const configFilePath = writeConfig("symlinked-repo.json", { projects: {} });
		expect(await ensureClaudeWorkspaceTrusted(repoLink, { configFilePath })).toEqual({
			changed: true,
			trustRootPath: repo,
		});
		expect(Object.keys(JSON.parse(readFileSync(configFilePath, "utf8")).projects)).toEqual([repo]);
	});
});

describe("claude workspace trust dialog fallback", () => {
	it("detects the current dialog", () => {
		expect(hasClaudeWorkspaceTrustPrompt(DIALOG_FIRST_RENDER)).toBe(true);
	});

	it("moves off the focused 'No, exit' before confirming", () => {
		expect(getClaudeWorkspaceTrustConfirmInput(DIALOG_FIRST_RENDER)).toBe("\u001b[B");
		expect(getClaudeWorkspaceTrustConfirmInput(DIALOG_FIRST_RENDER + DIALOG_AFTER_ARROW_DOWN)).toBe("\r");
	});

	it("confirms right away when 'Yes' is focused, as in older Claude Code builds", () => {
		expect(getClaudeWorkspaceTrustConfirmInput("❯ 1. Yes, I trust this folder\n  2. No, exit")).toBe("\r");
	});

	it("types nothing when the focus cannot be read", () => {
		expect(getClaudeWorkspaceTrustConfirmInput("Yes, I trust this folder\nNo, exit")).toBeNull();
	});
});

describe("shouldAutoConfirmClaudeWorkspaceTrust", () => {
	it("trusts Claude task worktrees in the current and the legacy worktree roots", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", join(home.worktreesRootPath, "abc12", "repo"))).toBe(
					true,
				);
				expect(
					shouldAutoConfirmClaudeWorkspaceTrust(
						"claude",
						join(home.userHomePath, ".cline", "worktrees", "old01", "repo"),
					),
				).toBe(true);
				expect(shouldAutoConfirmClaudeWorkspaceTrust("claude", join(home.userHomePath, "projects", "repo"))).toBe(
					false,
				);
				expect(shouldAutoConfirmClaudeWorkspaceTrust("codex", join(home.worktreesRootPath, "abc12", "repo"))).toBe(
					false,
				);
			},
			{ layout: "initialized" },
		);
	});

	it("keeps trusting ~/.cline/worktrees on the legacy home", async () => {
		await withTemporaryKanbanHome(
			(home) => {
				expect(
					shouldAutoConfirmClaudeWorkspaceTrust(
						"claude",
						join(home.userHomePath, ".cline", "worktrees", "d18bd", "kanban"),
					),
				).toBe(true);
			},
			{ layout: "legacy" },
		);
	});
});
