import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock git commands (the filesystem is a real temp dir) ──
const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execFilePromise: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, {
		[promisify.custom]: childProcessMocks.execFilePromise,
	}),
}));

import { type ProjectRoots, resolveProjectRoots } from "../../../src/projects/project-roots";
import { cloneGitRepository, deriveRepoNameFromUrl } from "../../../src/workspace/git-clone";

describe("deriveRepoNameFromUrl", () => {
	it("extracts repo name from HTTPS URL", () => {
		expect(deriveRepoNameFromUrl("https://github.com/user/my-repo.git")).toBe("my-repo");
	});

	it("extracts repo name from HTTPS URL without .git suffix", () => {
		expect(deriveRepoNameFromUrl("https://github.com/user/my-repo")).toBe("my-repo");
	});

	it("extracts repo name from SSH URL", () => {
		expect(deriveRepoNameFromUrl("git@github.com:user/my-repo.git")).toBe("my-repo");
	});

	it("extracts repo name from SSH URL without .git suffix", () => {
		expect(deriveRepoNameFromUrl("git@github.com:user/my-repo")).toBe("my-repo");
	});

	it("handles trailing slashes", () => {
		expect(deriveRepoNameFromUrl("https://github.com/user/my-repo.git/")).toBe("my-repo");
	});

	it("handles bare repository name", () => {
		expect(deriveRepoNameFromUrl("my-repo.git")).toBe("my-repo");
	});

	it("returns null for empty string", () => {
		expect(deriveRepoNameFromUrl("")).toBeNull();
	});

	it("returns null for whitespace-only string", () => {
		expect(deriveRepoNameFromUrl("   ")).toBeNull();
	});

	it("handles complex SSH paths", () => {
		expect(deriveRepoNameFromUrl("git@gitlab.com:org/sub-group/project.git")).toBe("project");
	});

	it("handles URL with nested path segments", () => {
		expect(deriveRepoNameFromUrl("https://gitlab.com/org/sub/deep/repo.git")).toBe("repo");
	});
});

describe("cloneGitRepository", () => {
	let sandbox: string;
	let root: string;
	let projectRoots: ProjectRoots;

	beforeEach(async () => {
		sandbox = realpathSync(mkdtempSync(join(tmpdir(), "kanban-test-clone-")));
		root = join(sandbox, "projects");
		mkdirSync(root);
		projectRoots = await resolveProjectRoots([root]);
		childProcessMocks.execFilePromise.mockReset();
		childProcessMocks.execFilePromise.mockResolvedValue({ stdout: "", stderr: "" });
	});

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	function cloneArgs(): string[] {
		return childProcessMocks.execFilePromise.mock.calls[0]?.[1] as string[];
	}

	it("clones to <first root>/<repo name> by default", async () => {
		const result = await cloneGitRepository("https://github.com/user/my-repo.git", projectRoots);

		expect(result).toEqual({ ok: true, clonedPath: join(root, "my-repo") });
		expect(childProcessMocks.execFilePromise).toHaveBeenCalledOnce();
		expect(childProcessMocks.execFilePromise.mock.calls[0]?.[0]).toBe("git");
		expect(cloneArgs()).toEqual(
			expect.arrayContaining(["clone", "https://github.com/user/my-repo.git", join(root, "my-repo")]),
		);
	});

	it("clones to a custom destination inside the root, creating missing parents", async () => {
		const dest = join(root, "nested", "dir", "repo");
		const result = await cloneGitRepository("https://github.com/user/my-repo.git", projectRoots, dest);

		expect(result).toEqual({ ok: true, clonedPath: dest });
	});

	it("clones into an existing empty directory", async () => {
		mkdirSync(join(root, "empty"));
		const result = await cloneGitRepository("https://github.com/user/my-repo.git", projectRoots, join(root, "empty"));

		expect(result).toEqual({ ok: true, clonedPath: join(root, "empty") });
	});

	it("refuses an existing non-empty directory or a file", async () => {
		mkdirSync(join(root, "used"));
		writeFileSync(join(root, "used", "file.txt"), "x");
		writeFileSync(join(root, "file"), "x");

		for (const dest of [join(root, "used"), join(root, "file")]) {
			const result = await cloneGitRepository("https://github.com/user/my-repo.git", projectRoots, dest);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("already exists and is not an empty directory");
		}
		expect(childProcessMocks.execFilePromise).not.toHaveBeenCalled();
	});

	it("refuses destinations outside the root, the root itself, a .. escape and a symlink escape", async () => {
		const outside = join(sandbox, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(root, "link"));
		const cases: Array<[string, string]> = [
			[join(sandbox, "elsewhere", "repo"), "outside the projects root"],
			[root, "the projects root itself"],
			[`${root}/../outside/repo`, 'contains ".."'],
			[join(root, "link", "repo"), "outside the projects root"],
		];
		for (const [dest, message] of cases) {
			const result = await cloneGitRepository("https://github.com/user/my-repo.git", projectRoots, dest);
			expect(result.ok, dest).toBe(false);
			expect(result.error).toContain(message);
		}
		expect(childProcessMocks.execFilePromise).not.toHaveBeenCalled();
	});

	it("returns an error when the repo name cannot be derived and no destination is given", async () => {
		const result = await cloneGitRepository("   ", projectRoots);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("Could not derive repository name");
	});

	it("returns an error when no projects root exists", async () => {
		const result = await cloneGitRepository(
			"https://github.com/user/my-repo.git",
			await resolveProjectRoots([join(sandbox, "missing")]),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("No projects root exists");
	});

	it("returns an error when git clone fails", async () => {
		childProcessMocks.execFilePromise.mockReset();
		childProcessMocks.execFilePromise.mockRejectedValueOnce(
			Object.assign(new Error("clone failed"), { code: 128, stdout: "", stderr: "fatal: repository not found" }),
		);

		const result = await cloneGitRepository("https://github.com/user/bad-repo.git", projectRoots);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("repository not found");
	});

	it("passes '--' before the URL to prevent flag injection", async () => {
		const maliciousUrl = "--upload-pack=/usr/bin/malicious";
		await cloneGitRepository(maliciousUrl, projectRoots, join(root, "repo"));

		const gitArgs = cloneArgs();
		const separatorIdx = gitArgs.indexOf("--");
		expect(separatorIdx).toBeGreaterThan(gitArgs.indexOf("clone"));
		expect(gitArgs.indexOf(maliciousUrl)).toBeGreaterThan(separatorIdx);
	});
});
