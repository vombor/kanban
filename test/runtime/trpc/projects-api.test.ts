import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeProjectTaskCounts } from "../../../src/core/api-contract";
import { resolveProjectRoots } from "../../../src/projects/project-roots";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { type CreateProjectsApiDependencies, createProjectsApi } from "../../../src/trpc/projects-api";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { realPath } from "../../utilities/temp-dir";

function createTestCwd(): string {
	const base = join(tmpdir(), `kanban-test-dir-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(base, { recursive: true });
	return base;
}

function createDefaultDeps(serverCwd: string): CreateProjectsApiDependencies {
	return {
		getActiveWorkspacePath: vi.fn(() => null),
		getActiveWorkspaceId: vi.fn(() => null),
		rememberWorkspace: vi.fn(),
		setActiveWorkspace: vi.fn(async () => {}),
		clearActiveWorkspace: vi.fn(),
		resolveProjectInputPath: vi.fn((inputPath: string, cwd: string) => resolve(cwd, inputPath)),
		assertPathIsDirectory: vi.fn(async () => {}),
		hasGitRepository: vi.fn(() => false),
		summarizeProjectTaskCounts: vi.fn(
			async (): Promise<RuntimeProjectTaskCounts> => ({
				backlog: 0,
				in_progress: 0,
				review: 0,
				trash: 0,
			}),
		),
		createProjectSummary: vi.fn(() => ({
			id: "test",
			path: "/test",
			name: "test",
			taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		})),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		getTerminalManagerForWorkspace: vi.fn(() => null),
		disposeWorkspace: vi.fn(() => ({
			terminalManager: null as TerminalSessionManager | null,
			workspacePath: null as string | null,
		})),
		collectProjectWorktreeTaskIdsForRemoval: vi.fn(() => new Set<string>()),
		warn: vi.fn(),
		buildProjectsPayload: vi.fn(async () => ({ currentProjectId: null, projects: [] })),
		pickDirectoryPathFromSystemDialog: vi.fn(() => null),
		serverCwd,
	};
}

describe("listDirectoryContents", () => {
	let testCwd: string;
	let filesystemRoot: string;

	beforeEach(() => {
		testCwd = createTestCwd();
		filesystemRoot = resolve(testCwd, "/");
	});

	afterEach(() => {
		rmSync(testCwd, { recursive: true, force: true });
	});

	it("returns filesystem root when path is empty", async () => {
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, {});
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(filesystemRoot);
		expect(result.parentPath).toBeNull();
		expect(result.rootPath).toBe(filesystemRoot);
	});

	it("returns filesystem root when path is undefined (no path key)", async () => {
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: undefined });
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(filesystemRoot);
		expect(result.rootPath).toBe(filesystemRoot);
	});

	it("returns contents for a valid absolute path", async () => {
		const subdir = join(testCwd, "sub");
		mkdirSync(subdir);
		mkdirSync(join(subdir, "child-a"));
		mkdirSync(join(subdir, "child-b"));
		writeFileSync(join(subdir, "file.txt"), "content");
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: subdir });
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(subdir);
		expect(result.parentPath).toBe(testCwd);
		expect(result.entries).toHaveLength(2);
		expect(result.entries.map((e) => e.name)).toEqual(["child-a", "child-b"]);
	});

	it("allows browsing paths outside the launch directory", async () => {
		const siblingDir = join(dirname(testCwd), `kanban-sibling-${Date.now()}`);
		mkdirSync(siblingDir, { recursive: true });
		mkdirSync(join(siblingDir, "inside"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: siblingDir });
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(siblingDir);
		expect(result.entries.map((e) => e.name)).toContain("inside");
		rmSync(siblingDir, { recursive: true, force: true });
	});

	it("returns subdirectory contents for another valid absolute path", async () => {
		const subdir = join(testCwd, "abs-sub");
		mkdirSync(subdir);
		mkdirSync(join(subdir, "inside"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: subdir });
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(subdir);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("inside");
	});

	it("detects git repositories via .git directory", async () => {
		mkdirSync(join(testCwd, "my-repo", ".git"), { recursive: true });
		mkdirSync(join(testCwd, "not-a-repo"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: testCwd });
		expect(result.ok).toBe(true);
		const repoEntry = result.entries.find((e) => e.name === "my-repo");
		const nonRepoEntry = result.entries.find((e) => e.name === "not-a-repo");
		expect(repoEntry?.isGitRepository).toBe(true);
		expect(nonRepoEntry?.isGitRepository).toBe(false);
	});

	it("excludes hidden directories (starting with .)", async () => {
		mkdirSync(join(testCwd, ".hidden"));
		mkdirSync(join(testCwd, "visible"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: testCwd });
		expect(result.ok).toBe(true);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("visible");
	});

	it("sorts entries alphabetically", async () => {
		mkdirSync(join(testCwd, "zebra"));
		mkdirSync(join(testCwd, "apple"));
		mkdirSync(join(testCwd, "mango"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: testCwd });
		expect(result.ok).toBe(true);
		expect(result.entries.map((e) => e.name)).toEqual(["apple", "mango", "zebra"]);
	});

	it("returns empty entries for a directory with no subdirectories", async () => {
		writeFileSync(join(testCwd, "file1.txt"), "data");
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: testCwd });
		expect(result.ok).toBe(true);
		expect(result.entries).toEqual([]);
	});

	it("allows absolute paths within the filesystem root", async () => {
		const subdir = join(testCwd, "abs-allowed");
		mkdirSync(subdir);
		mkdirSync(join(subdir, "nested"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: subdir });
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(subdir);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("nested");
	});

	it("allows absolute path equal to rootPath", async () => {
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: filesystemRoot });
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(filesystemRoot);
	});

	it("keeps traversal bounded at filesystem root", async () => {
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, {
			path: "../../../../../../../../..",
		});
		expect(result.ok).toBe(true);
		expect(result.currentPath).toBe(filesystemRoot);
	});

	it("parentPath is null when at filesystem root", async () => {
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, {});
		expect(result.ok).toBe(true);
		expect(result.parentPath).toBeNull();
	});

	it("parentPath points to launch directory when one level deep under it", async () => {
		mkdirSync(join(testCwd, "level1"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: join(testCwd, "level1") });
		expect(result.ok).toBe(true);
		expect(result.parentPath).toBe(testCwd);
	});

	it("parentPath correctly chains when deeply nested", async () => {
		mkdirSync(join(testCwd, "a", "b", "c"), { recursive: true });
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: join(testCwd, "a", "b", "c") });
		expect(result.ok).toBe(true);
		expect(result.parentPath).toBe(join(testCwd, "a", "b"));
	});

	// ── Error handling ──────────────────────────────────────

	it("returns error for non-existent directory", async () => {
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: join(testCwd, "does-not-exist") });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Directory not found.");
		expect(result.entries).toEqual([]);
	});

	it("returns error when path points to a file", async () => {
		writeFileSync(join(testCwd, "a-file.txt"), "hello");
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: join(testCwd, "a-file.txt") });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("The specified path is not a directory.");
	});

	// ── Schema validation ───────────────────────────────────

	it("success response validates against the schema", async () => {
		const { runtimeDirectoryListResponseSchema } = await import("../../../src/core/api-contract");
		mkdirSync(join(testCwd, "valid-dir"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: testCwd });
		expect(runtimeDirectoryListResponseSchema.safeParse(result).success).toBe(true);
	});

	it("error response validates against the schema", async () => {
		const { runtimeDirectoryListResponseSchema } = await import("../../../src/core/api-contract");
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: join(testCwd, "does-not-exist") });
		expect(runtimeDirectoryListResponseSchema.safeParse(result).success).toBe(true);
	});

	// ── Misc ────────────────────────────────────────────────

	it("includes rootPath in every response", async () => {
		mkdirSync(join(testCwd, "sub"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		expect((await api.listDirectoryContents(null, {})).rootPath).toBe(filesystemRoot);
		expect((await api.listDirectoryContents(null, { path: testCwd })).rootPath).toBe(filesystemRoot);
		expect((await api.listDirectoryContents(null, { path: join(testCwd, "sub") })).rootPath).toBe(filesystemRoot);
	});

	it("entry paths are absolute", async () => {
		mkdirSync(join(testCwd, "my-project"));
		const api = createProjectsApi(createDefaultDeps(testCwd));
		const result = await api.listDirectoryContents(null, { path: testCwd });
		expect(result.ok).toBe(true);
		expect(result.entries[0]?.path).toBe(join(testCwd, "my-project"));
	});
});

describe("addProject", () => {
	let testCwd: string;

	beforeEach(() => {
		testCwd = createTestCwd();
	});

	afterEach(() => {
		rmSync(testCwd, { recursive: true, force: true });
	});

	it("backward compat: accepts a path-only request", async () => {
		const deps = createDefaultDeps(testCwd);
		(deps.hasGitRepository as ReturnType<typeof vi.fn>).mockReturnValue(true);
		const api = createProjectsApi(deps);
		const result = await api.addProject(null, { path: testCwd });
		// The existing flow runs; we're verifying it doesn't throw on path-only input.
		// Since loadWorkspaceContext is a real call that needs a git repo, the catch
		// block will handle it. The important thing is no schema-level crash.
		expect(typeof result.ok).toBe("boolean");
	});

	it("rejects request with neither path nor gitUrl", async () => {
		const deps = createDefaultDeps(testCwd);
		const api = createProjectsApi(deps);
		await expect(api.addProject(null, {})).rejects.toThrow();
	});

	it("resolves clone destination relative to the first projects root, not the active project", async () => {
		const activeProjectPath = join(testCwd, "active-project");
		mkdirSync(activeProjectPath);
		const deps = createDefaultDeps(testCwd);
		const projectRoots = await resolveProjectRoots([testCwd]);
		deps.readProjectRoots = async () => projectRoots;
		(deps.getActiveWorkspacePath as ReturnType<typeof vi.fn>).mockReturnValue(activeProjectPath);
		const api = createProjectsApi(deps);
		// The clone itself will fail (no real git server), but we can verify
		// that resolveProjectInputPath was called with the projects root as the base.
		await api.addProject(null, { gitUrl: "https://example.com/repo.git", path: "my-new-proj" });
		const resolveSpy = deps.resolveProjectInputPath as ReturnType<typeof vi.fn>;
		expect(resolveSpy).toHaveBeenCalledWith("my-new-proj", realPath(testCwd));
		// Crucially, it must NOT have been called with the active project path:
		expect(resolveSpy).not.toHaveBeenCalledWith("my-new-proj", realPath(activeProjectPath));
	});
});

describe("projects roots over tRPC: create, checkName, roots, open folder", () => {
	const gitEnvKeys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
	let savedGitEnv: Array<[string, string | undefined]>;

	beforeEach(() => {
		savedGitEnv = gitEnvKeys.map((key) => [key, process.env[key]]);
		for (const key of gitEnvKeys) {
			process.env[key] = key.endsWith("EMAIL") ? "test@test.com" : "Test";
		}
	});

	afterEach(() => {
		for (const [key, value] of savedGitEnv) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	async function withRoot(
		run: (input: {
			root: string;
			outside: string;
			api: ReturnType<typeof createProjectsApi>;
			deps: CreateProjectsApiDependencies;
		}) => Promise<void>,
	): Promise<void> {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const home = realpathSync(userHomePath);
			const root = join(home, "projects");
			const outside = join(home, "outside");
			mkdirSync(root);
			mkdirSync(outside);
			const projectRoots = await resolveProjectRoots([root]);
			const deps = createDefaultDeps(home);
			deps.readProjectRoots = async () => projectRoots;
			deps.resolveProjectInputPath = vi.fn((inputPath: string, cwd: string) => resolve(cwd, inputPath));
			await run({ root, outside, api: createProjectsApi(deps), deps });
		});
	}

	it("returns the roots", async () => {
		await withRoot(async ({ api, root }) => {
			expect(await api.getProjectRoots()).toEqual({ roots: [root] });
		});
	});

	it("checkName answers only exists / isGitRepository / isEmpty, and only under a root", async () => {
		await withRoot(async ({ api, root, outside }) => {
			mkdirSync(join(root, "repo", ".git"), { recursive: true });
			expect(await api.checkProjectName({ root, name: "repo" })).toEqual({
				ok: true,
				exists: true,
				isGitRepository: true,
				isEmpty: false,
			});
			expect(await api.checkProjectName({ root, name: "fresh" })).toEqual({
				ok: true,
				exists: false,
				isGitRepository: false,
				isEmpty: false,
			});
			const refused = await api.checkProjectName({ root: outside, name: "x" });
			expect(refused).toMatchObject({ ok: false, exists: false });
			expect(await api.checkProjectName({ root, name: "../outside" })).toMatchObject({ ok: false, exists: false });
		});
	});

	it("create makes, registers and activates the project", async () => {
		await withRoot(async ({ api, deps, root }) => {
			const result = await api.createProject(null, { path: join(root, "new-app"), name: "New App" });
			expect(result).toMatchObject({ ok: true, notes: [] });
			expect(deps.rememberWorkspace).toHaveBeenCalledWith(expect.any(String), join(root, "new-app"));
			expect(deps.setActiveWorkspace).toHaveBeenCalledOnce();
			expect(deps.broadcastRuntimeProjectsUpdated).toHaveBeenCalled();
		});
	});

	it("create re-checks on the server: a name taken after the typeahead said 'available' is refused", async () => {
		await withRoot(async ({ api, root }) => {
			expect(await api.checkProjectName({ root, name: "race" })).toMatchObject({ exists: false });
			// Someone else creates it between the check and the click.
			mkdirSync(join(root, "race"));
			writeFileSync(join(root, "race", "theirs.txt"), "x");
			const result = await api.createProject(null, { path: join(root, "race") });
			expect(result).toMatchObject({ ok: false, project: null });
			expect(result.error).toContain("already exists and is not empty");
			expect(readdirSync(join(root, "race"))).toEqual(["theirs.txt"]);
		});
	});

	it("create returns errors for paths outside the root", async () => {
		await withRoot(async ({ api, root, outside }) => {
			expect((await api.createProject(null, { path: join(outside, "app") })).error).toContain(
				"outside the projects root",
			);
			expect((await api.createProject(null, { path: root })).error).toContain("the projects root itself");
		});
	});

	it("open folder refuses a directory outside the root and accepts one inside", async () => {
		await withRoot(async ({ api, deps, root, outside }) => {
			(deps.hasGitRepository as ReturnType<typeof vi.fn>).mockReturnValue(true);
			const refused = await api.addProject(null, { path: outside });
			expect(refused).toMatchObject({ ok: false, project: null });
			expect(refused.error).toContain("outside the projects root");

			const inside = join(root, "existing");
			mkdirSync(inside);
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: inside, env: createGitTestEnv() });
			execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: inside, env: createGitTestEnv() });
			expect(await api.addProject(null, { path: inside })).toMatchObject({ ok: true });
		});
	});
});
