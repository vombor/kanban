import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	hasParentDirectorySegment,
	slugifyProjectName,
	validateProjectDirectoryName,
} from "../../../src/core/project-paths";
import {
	checkProjectDirectoryName,
	findEnclosingGitDirectory,
	getDefaultProjectRoots,
	PROJECTS_ROOTS_ENV,
	type ProjectRoots,
	readProjectRoots,
	resolvePathInsideProjectRoots,
	resolveProjectRoots,
} from "../../../src/projects/project-roots";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

let sandbox: string;
let root: string;
let projectRoots: ProjectRoots;

beforeEach(async () => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "kanban-project-roots-")));
	root = join(sandbox, "projects");
	mkdirSync(root);
	projectRoots = await resolveProjectRoots([root]);
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("project path helpers", () => {
	it("slugifies a project name into a safe directory name", () => {
		expect(slugifyProjectName("My Cool App!")).toBe("my-cool-app");
		expect(slugifyProjectName("  Café  Ünïcode ")).toBe("cafe-unicode");
		expect(slugifyProjectName("__.hidden--")).toBe("hidden");
		expect(slugifyProjectName("!!!")).toBe("");
	});

	it("validates a directory name: one safe segment", () => {
		expect(validateProjectDirectoryName("my-app_1.0")).toBeNull();
		expect(validateProjectDirectoryName("")).toContain("Enter");
		expect(validateProjectDirectoryName("a/b")).toContain("slashes");
		expect(validateProjectDirectoryName("..")).toContain("not a directory name");
		expect(validateProjectDirectoryName(".hidden")).toContain("letters, digits");
		expect(validateProjectDirectoryName("a b")).toContain("letters, digits");
		expect(validateProjectDirectoryName("x".repeat(101))).toContain("longer");
	});

	it("spots .. segments", () => {
		expect(hasParentDirectorySegment("/projects/../etc")).toBe(true);
		expect(hasParentDirectorySegment("/projects/a..b")).toBe(false);
	});
});

describe("projects roots", () => {
	it("defaults to $KANBAN_PROJECTS_ROOTS, else /projects in a container, else home", () => {
		expect(getDefaultProjectRoots({ env: { [PROJECTS_ROOTS_ENV]: "/a:/b" }, isContainer: true })).toEqual({
			roots: ["/a", "/b"],
			source: "env",
		});
		expect(getDefaultProjectRoots({ env: {}, isContainer: true })).toEqual({
			roots: ["/projects"],
			source: "container",
		});
		expect(getDefaultProjectRoots({ env: {}, isContainer: false, homeDir: "/home/me" })).toEqual({
			roots: ["/home/me"],
			source: "home",
		});
	});

	it("reads projects.roots from config.json, realpaths them and lists missing ones", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			mkdirSync(join(globalConfigPath, ".."), { recursive: true });
			symlinkSync(root, join(sandbox, "alias"));
			writeFileSync(
				globalConfigPath,
				JSON.stringify({ projects: { roots: [join(sandbox, "alias"), join(sandbox, "missing")] } }),
			);
			const resolved = await readProjectRoots();
			expect(resolved).toMatchObject({ roots: [root], missing: [join(sandbox, "missing")], source: "config" });
		});
	});
});

describe("resolvePathInsideProjectRoots", () => {
	it("accepts a path strictly inside a root, existing or not (nested, for mkdir -p)", async () => {
		mkdirSync(join(root, "app"));
		expect(await resolvePathInsideProjectRoots(join(root, "app"), projectRoots)).toEqual({
			ok: true,
			path: join(root, "app"),
			root,
		});
		expect(await resolvePathInsideProjectRoots(join(root, "new", "deep", "app"), projectRoots)).toMatchObject({
			ok: true,
			path: join(root, "new", "deep", "app"),
		});
	});

	it("refuses outside, the root itself, a .. escape, a symlink escape and relative paths", async () => {
		const outside = join(sandbox, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(root, "escape"));
		const cases: Array<[string, string]> = [
			[outside, "outside the projects root"],
			[`${root}-sibling/app`, "outside the projects root"],
			[root, "the projects root itself"],
			[`${root}/`, "the projects root itself"],
			[`${root}/app/../../outside`, 'contains ".."'],
			[join(root, "escape"), `resolves to ${outside}`],
			[join(root, "escape", "new-app"), "outside the projects root"],
			["projects/app", "not an absolute path"],
		];
		for (const [path, message] of cases) {
			const check = await resolvePathInsideProjectRoots(path, projectRoots);
			expect(check.ok, path).toBe(false);
			expect(check.ok ? "" : check.error, path).toContain(message);
		}
	});

	it("follows a symlink that stays inside the root", async () => {
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "alias"));
		expect(await resolvePathInsideProjectRoots(join(root, "alias", "app"), projectRoots)).toMatchObject({
			ok: true,
			path: join(root, "real", "app"),
		});
	});

	it("refuses everything when no root exists", async () => {
		const none = await resolveProjectRoots([join(sandbox, "missing")]);
		const check = await resolvePathInsideProjectRoots(join(sandbox, "missing", "app"), none);
		expect(check.ok ? "" : check.error).toContain("No projects root exists");
	});
});

describe("checkProjectDirectoryName", () => {
	it("answers exists / isGitRepository / isEmpty for one name directly under a root", async () => {
		mkdirSync(join(root, "empty"));
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		mkdirSync(join(root, "files"));
		writeFileSync(join(root, "files", "a.txt"), "a");
		const check = (name: string) => checkProjectDirectoryName({ root, name }, projectRoots);
		expect(await check("fresh")).toMatchObject({ ok: true, exists: false, isGitRepository: false, isEmpty: false });
		expect(await check("empty")).toMatchObject({ ok: true, exists: true, isGitRepository: false, isEmpty: true });
		expect(await check("repo")).toMatchObject({ ok: true, exists: true, isGitRepository: true, isEmpty: false });
		expect(await check("files")).toMatchObject({ ok: true, exists: true, isGitRepository: false, isEmpty: false });
	});

	it("refuses other roots, nested names, .. and unsafe characters without touching the filesystem", async () => {
		expect(await checkProjectDirectoryName({ root: sandbox, name: "projects" }, projectRoots)).toMatchObject({
			ok: false,
			exists: false,
		});
		for (const name of ["a/b", "..", "../outside", "x y", ""]) {
			const check = await checkProjectDirectoryName({ root, name }, projectRoots);
			expect(check.ok, name).toBe(false);
			expect(check.exists).toBe(false);
		}
	});
});

describe("findEnclosingGitDirectory", () => {
	it("finds a .git dir or file in the directory or any parent up to the root", async () => {
		mkdirSync(join(root, "outer", ".git"), { recursive: true });
		mkdirSync(join(root, "wt"), { recursive: true });
		writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere\n");
		expect(await findEnclosingGitDirectory(join(root, "outer", "inner", "app"), root)).toBe(join(root, "outer"));
		expect(await findEnclosingGitDirectory(join(root, "wt"), root)).toBe(join(root, "wt"));
		expect(await findEnclosingGitDirectory(join(root, "plain"), root)).toBeNull();
	});
});
