import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { readPipelineConfig } from "../../../src/config/pipeline-config";
import { addProject, resolveProjectRepoPath } from "../../../src/projects/project-add";
import { syncProjectSections } from "../../../src/projects/project-sections";
import { listWorkspaceIndexEntries } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, env: createGitTestEnv(), encoding: "utf8" }).trim();
}

function createRepo(path: string, options: { commit?: boolean } = {}): string {
	mkdirSync(path, { recursive: true });
	git(path, ["init", "-q", "-b", "main"]);
	if (options.commit !== false) {
		writeFileSync(join(path, "README.md"), "# repo\n");
		git(path, ["add", "."]);
		git(path, ["commit", "-q", "-m", "init"]);
	}
	return realpathSync(path);
}

function writeConfig(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

describe("kanban project add", () => {
	it("registers a repo on the default kit with landing off and writes no config entry", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath, globalConfigPath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			const result = await addProject({ repoPath: repo });
			expect(result).toMatchObject({ repoPath: repo, registered: true, kitName: "default", landingMode: "off" });
			expect((await listWorkspaceIndexEntries()).map((entry) => entry.repoPath)).toEqual([repo]);
			expect(result.config).toEqual(["no entry: kit default, landing off"]);
			expect((await readPipelineConfig(globalConfigPath)).config.workspaces).toEqual({});
			// Adding it again changes nothing.
			expect(await addProject({ repoPath: repo })).toMatchObject({ registered: false, kitName: "default" });
		});
	});

	it("applies --kit/--landing/--blurb/--base to a new project and never copies another project's settings", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath, globalConfigPath }) => {
			writeConfig(globalConfigPath, {
				workspaces: {
					other: { landing: { mode: "qa" }, kit: { name: "team", overrides: { "qa.blurb": "Other" } } },
				},
			});
			const repo = createRepo(join(userHomePath, "shop"));
			const result = await addProject({
				repoPath: repo,
				kit: "team",
				landing: "qa",
				blurb: "Project: shop",
				base: "main",
			});
			expect(result).toMatchObject({ kitName: "team", landingMode: "qa" });
			const { config } = await readPipelineConfig(globalConfigPath);
			expect(config.workspaces[result.workspaceId]).toMatchObject({
				landing: { mode: "qa" },
				defaultBaseRef: "main",
				kit: { name: "team", overrides: { "qa.blurb": "Project: shop" } },
			});

			const plain = createRepo(join(userHomePath, "plain"));
			const plainResult = await addProject({ repoPath: plain });
			expect(plainResult).toMatchObject({ kitName: "default", landingMode: "off" });
			expect(Object.hasOwn(config.workspaces, plainResult.workspaceId)).toBe(false);
		});
	});

	it("keeps an existing project's kit and landing mode, and says how to change them", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath, globalConfigPath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			const first = await addProject({ repoPath: repo, kit: "team", landing: "off" });
			const second = await addProject({ repoPath: repo, kit: "default", landing: "qa", name: "App" });
			expect(second).toMatchObject({ kitName: "team", landingMode: "off" });
			expect(second.warnings.join("\n")).toContain(`kanban kit apply default --project ${first.workspaceId}`);
			expect(second.warnings.join("\n")).toContain("landing qa not applied");
			const { config } = await readPipelineConfig(globalConfigPath);
			expect(config.workspaces[first.workspaceId]?.name).toBe("App");
		});
	});

	it("refuses a subdirectory, a linked worktree and a repo without commits", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			mkdirSync(join(repo, "src"));
			await expect(resolveProjectRepoPath(join(repo, "src"))).rejects.toThrow("not the top of its git repository");
			const worktree = join(userHomePath, "wt");
			git(repo, ["worktree", "add", "-q", "--detach", worktree]);
			await expect(resolveProjectRepoPath(worktree)).rejects.toThrow(`add the main checkout ${repo} instead`);
			const empty = createRepo(join(userHomePath, "empty"), { commit: false });
			await expect(resolveProjectRepoPath(empty)).rejects.toThrow("has no commits yet");
			await expect(resolveProjectRepoPath(join(userHomePath, "missing"))).rejects.toThrow("is not a directory");
		});
	});

	it("--agents-md appends the managed section once; project sync keeps it current", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			writeFileSync(join(repo, "AGENTS.md"), "# Our rules\n");
			const result = await addProject({ repoPath: repo, agentsMd: true, base: "main" });
			expect(result.agentsMd?.action).toBe("added");
			const text = readFileSync(join(repo, "AGENTS.md"), "utf8");
			expect(text.startsWith("# Our rules\n\n<!-- kanban:managed begin agents-qa ")).toBe(true);
			expect(text).toContain("squash onto `main`");
			expect((await addProject({ repoPath: repo, agentsMd: true })).agentsMd?.detail).toBe(
				"managed section already there",
			);

			const { config } = await readPipelineConfig();
			expect(
				await syncProjectSections({ config, workspaceId: result.workspaceId, repoPath: repo, dryRun: false }),
			).toMatchObject([{ action: "up-to-date" }]);
		});
	});

	it("project sync replaces a legacy kit section, dry run first, and leaves a file without one alone", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			const legacy =
				"# Ours\n<!-- kanban-kit:begin agents-qa (managed by the kit) -->\nOld kit text\n<!-- kanban-kit:end agents-qa -->\n";
			writeFileSync(join(repo, "AGENTS.md"), legacy);
			const { workspaceId } = await addProject({ repoPath: repo });
			const { config } = await readPipelineConfig();
			const input = { config, workspaceId, repoPath: repo };
			expect(await syncProjectSections({ ...input, dryRun: true })).toMatchObject([
				{ action: "would-update", state: "legacy" },
			]);
			expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(legacy);
			expect(await syncProjectSections({ ...input, dryRun: false })).toMatchObject([{ action: "updated" }]);
			const text = readFileSync(join(repo, "AGENTS.md"), "utf8");
			expect(text.startsWith("# Ours\n<!-- kanban:managed begin agents-qa ")).toBe(true);
			expect(text).not.toContain("kanban-kit:");
			expect(text).toContain("<!-- kanban:managed end agents-qa -->");

			writeFileSync(join(repo, "AGENTS.md"), "# no section\n");
			expect(await syncProjectSections({ ...input, dryRun: false })).toMatchObject([{ action: "left-alone" }]);
			expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("# no section\n");
		});
	});
});
