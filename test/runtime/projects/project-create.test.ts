import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerProjectCommand } from "../../../src/commands/project";
import { readPipelineConfig } from "../../../src/config/pipeline-config";
import { addProject } from "../../../src/projects/project-add";
import { createProject, FALLBACK_GIT_IDENTITY } from "../../../src/projects/project-create";
import { type ProjectRoots, resolveProjectRoots } from "../../../src/projects/project-roots";
import { listWorkspaceIndexEntries } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { type TemporaryKanbanHome, withTemporaryKanbanHome } from "../../utilities/kanban-home";

const IDENTITY_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
const GIT_ENV = [...IDENTITY_ENV, "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "XDG_CONFIG_HOME"];
let savedEnv: Map<string, string | undefined>;

beforeEach(() => {
	savedEnv = new Map(GIT_ENV.map((key) => [key, process.env[key]]));
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_AUTHOR_NAME = "Test";
	process.env.GIT_AUTHOR_EMAIL = "test@test.com";
	process.env.GIT_COMMITTER_NAME = "Test";
	process.env.GIT_COMMITTER_EMAIL = "test@test.com";
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, env: createGitTestEnv(), encoding: "utf8" }).trim();
}

/** A temp Kanban home with a projects root `<home>/projects` (and nothing else allowed). */
async function withProjectsRoot(
	run: (context: TemporaryKanbanHome & { root: string; projectRoots: ProjectRoots }) => Promise<void>,
): Promise<void> {
	await withTemporaryKanbanHome(async (home) => {
		const root = join(realpathSync(home.userHomePath), "projects");
		mkdirSync(root);
		mkdirSync(join(home.globalConfigPath, ".."), { recursive: true });
		writeFileSync(home.globalConfigPath, JSON.stringify({ projects: { roots: [root] } }));
		await run({ ...home, root, projectRoots: await resolveProjectRoots([root]) });
	});
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	const program = new Command();
	program.exitOverride();
	registerProjectCommand(program);
	let stdout = "";
	let stderr = "";
	const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	const previous = process.exitCode;
	process.exitCode = undefined;
	try {
		await program.parseAsync(["node", "kanban", "project", ...args]);
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		out.mockRestore();
		err.mockRestore();
		process.exitCode = previous;
	}
}

describe("createProject", () => {
	it("creates a new directory (mkdir -p), git inits it on main, commits a README and adds it on the default kit", async () => {
		await withProjectsRoot(async ({ root, globalConfigPath }) => {
			const path = join(root, "group", "my-app");
			const result = await createProject({ path, name: "My App" });
			expect(result).toMatchObject({
				repoPath: path,
				name: "My App",
				initialBranch: "main",
				commitIdentity: "git-config",
				notes: [],
				project: { registered: true, kitName: "default", landingMode: "off" },
			});
			expect(readFileSync(join(path, "README.md"), "utf8")).toBe("# My App\n");
			expect(git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
			expect(git(path, ["rev-parse", "HEAD"])).toBe(result.initialCommit);
			expect(git(path, ["log", "-1", "--format=%an <%ae>"])).toBe("Test <test@test.com>");
			expect((await listWorkspaceIndexEntries()).map((entry) => entry.repoPath)).toEqual([path]);
			// Only the display name is written; no kit, so it stays on the default kit with landing off.
			expect(
				(await readPipelineConfig(globalConfigPath)).config.workspaces[result.project.workspaceId],
			).toMatchObject({ name: "My App", kit: null, landing: { mode: "off" } });
		});
	});

	it("uses an existing empty directory and a custom branch", async () => {
		await withProjectsRoot(async ({ root, projectRoots }) => {
			const path = join(root, "empty");
			mkdirSync(path);
			const result = await createProject({ path, initialBranch: "trunk", projectRoots });
			expect(result).toMatchObject({ repoPath: path, name: "empty", initialBranch: "trunk" });
			expect(git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("trunk");
		});
	});

	it("refuses a non-empty directory, an existing repo and a directory inside a repo, pointing to Open folder", async () => {
		await withProjectsRoot(async ({ root, projectRoots }) => {
			mkdirSync(join(root, "files"));
			writeFileSync(join(root, "files", "notes.txt"), "keep me");
			mkdirSync(join(root, "repo"));
			git(join(root, "repo"), ["init", "-q"]);
			writeFileSync(join(root, "file"), "x");
			const cases: Array<[string, string]> = [
				[join(root, "files"), "already exists and is not empty"],
				[join(root, "repo"), "is already a git repository"],
				[join(root, "repo", "sub", "app"), `inside the git repository ${join(root, "repo")}`],
				[join(root, "file"), "is not a directory"],
			];
			for (const [path, message] of cases) {
				const error = await createProject({ path, projectRoots }).catch((caught: Error) => caught);
				expect(error, path).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(message);
				if (!message.includes("not a directory")) {
					expect((error as Error).message).toContain("Open folder");
				}
			}
			expect(readFileSync(join(root, "files", "notes.txt"), "utf8")).toBe("keep me");
			expect(existsSync(join(root, "repo", "sub"))).toBe(false);
			expect(await listWorkspaceIndexEntries()).toEqual([]);
		});
	});

	it("refuses paths outside the root, the root itself, .. and symlink escapes", async () => {
		await withProjectsRoot(async ({ root, userHomePath, projectRoots }) => {
			const outside = join(realpathSync(userHomePath), "outside");
			mkdirSync(outside);
			symlinkSync(outside, join(root, "link"));
			for (const path of [join(outside, "app"), root, `${root}/../outside/app`, join(root, "link", "app")]) {
				await expect(createProject({ path, projectRoots }), path).rejects.toThrow(/projects root|"\.\."/);
			}
			expect(existsSync(join(outside, "app"))).toBe(false);
		});
	});

	it("commits with a fallback identity scoped to that commit when git has none, and says so", async () => {
		await withProjectsRoot(async ({ root, userHomePath, projectRoots }) => {
			for (const key of IDENTITY_ENV) {
				delete process.env[key];
			}
			const emptyGlobal = join(userHomePath, "empty.gitconfig");
			writeFileSync(emptyGlobal, "");
			process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
			process.env.XDG_CONFIG_HOME = join(userHomePath, "xdg");
			const path = join(root, "anon");
			const result = await createProject({ path, projectRoots });
			expect(result.commitIdentity).toBe("fallback");
			expect(result.notes.join("\n")).toContain(FALLBACK_GIT_IDENTITY.name);
			expect(result.notes.join("\n")).toContain("did not change any git config");
			expect(git(path, ["log", "-1", "--format=%an <%ae>"])).toBe(
				`${FALLBACK_GIT_IDENTITY.name} <${FALLBACK_GIT_IDENTITY.email}>`,
			);
			expect(readFileSync(emptyGlobal, "utf8")).toBe("");
			expect(readFileSync(join(path, ".git", "config"), "utf8")).not.toContain("[user]");
		});
	});

	it("with the initial commit off, only git inits and registers the unborn repo with a note", async () => {
		await withProjectsRoot(async ({ root, projectRoots }) => {
			const path = join(root, "bare");
			const result = await createProject({ path, initialCommit: false, projectRoots });
			expect(result).toMatchObject({ initialCommit: null, commitIdentity: null, project: { registered: true } });
			expect(result.notes.join("\n")).toContain("first commit");
			expect(existsSync(join(path, ".git"))).toBe(true);
			expect(existsSync(join(path, "README.md"))).toBe(false);
		});
	});

	it("refuses an invalid branch and leaves nothing behind", async () => {
		await withProjectsRoot(async ({ root, projectRoots }) => {
			await expect(
				createProject({ path: join(root, "x", "app"), initialBranch: "bad..name", projectRoots }),
			).rejects.toThrow("not a valid branch name");
			expect(existsSync(join(root, "x"))).toBe(false);
		});
	});

	it("reports git missing", async () => {
		await withProjectsRoot(async ({ root, projectRoots }) => {
			const previousPath = process.env.PATH;
			process.env.PATH = join(root, "no-bin");
			try {
				await expect(createProject({ path: join(root, "app"), projectRoots })).rejects.toThrow(
					"git is not available",
				);
			} finally {
				process.env.PATH = previousPath;
			}
			expect(existsSync(join(root, "app"))).toBe(false);
		});
	});
});

describe("open folder (kanban project add) under the projects root", () => {
	it("adds a repo inside the root and refuses one outside or the root itself; registered ones keep working", async () => {
		await withProjectsRoot(async ({ root, userHomePath, globalConfigPath }) => {
			const makeRepo = (path: string) => {
				mkdirSync(path, { recursive: true });
				git(path, ["init", "-q", "-b", "main"]);
				git(path, ["commit", "-q", "--allow-empty", "-m", "init"]);
				return realpathSync(path);
			};
			const inside = makeRepo(join(root, "inside"));
			const outside = makeRepo(join(userHomePath, "outside"));
			expect(await addProject({ repoPath: inside })).toMatchObject({ registered: true });
			await expect(addProject({ repoPath: outside })).rejects.toThrow("outside the projects root");
			symlinkSync(outside, join(root, "link"));
			await expect(addProject({ repoPath: join(root, "link") })).rejects.toThrow("outside the projects root");

			// A project registered before the rule (here: while the root was wider) is left alone.
			writeFileSync(globalConfigPath, JSON.stringify({ projects: { roots: [realpathSync(userHomePath)] } }));
			expect(await addProject({ repoPath: outside })).toMatchObject({ registered: true });
			writeFileSync(globalConfigPath, JSON.stringify({ projects: { roots: [root] } }));
			expect(await addProject({ repoPath: outside })).toMatchObject({ registered: false });
		});
	});
});

describe("kanban project create", () => {
	it("creates and adds a project, and prints what it did", async () => {
		await withProjectsRoot(async ({ root }) => {
			const result = await runCli(["create", join(root, "cli-app"), "--name", "CLI App", "--branch", "develop"]);
			expect(result.exitCode).toBeUndefined();
			expect(result.stdout).toContain(
				`Created ${join(root, "cli-app")} (CLI App): git init -b develop, initial commit`,
			);
			expect(result.stdout).toContain("Kit default, landing off.");
			expect(git(join(root, "cli-app"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("develop");
		});
	});

	it("--no-initial-commit and --json", async () => {
		await withProjectsRoot(async ({ root }) => {
			const result = await runCli(["create", join(root, "cli-bare"), "--no-initial-commit", "--json"]);
			const payload = JSON.parse(result.stdout) as {
				ok: boolean;
				initialCommit: string | null;
				initialBranch: string;
			};
			expect(payload).toMatchObject({ ok: true, initialCommit: null, initialBranch: "main" });
		});
	});

	it("fails with the reason for a path outside the root", async () => {
		await withProjectsRoot(async ({ userHomePath }) => {
			const result = await runCli(["create", join(userHomePath, "nope")]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Project create failed:");
			expect(result.stderr).toContain("outside the projects root");
			expect(existsSync(join(userHomePath, "nope"))).toBe(false);
		});
	});
});
