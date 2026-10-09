import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkProjectShortcuts } from "../../../src/doctor/project-shortcut-checks";
import { readProjectShortcutStore, readProjectShortcuts } from "../../../src/projects/project-shortcut-store";
import { getProjectKanbanConfigPath, getProjectShortcutsPath } from "../../../src/state/kanban-home";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, env: createGitTestEnv() });
}

describe("doctor: project shortcuts", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	const setup = () => {
		const temp = createTempDir("kanban-doctor-shortcuts-");
		temps.push(temp);
		const homePath = join(temp.path, "home");
		const repoPath = join(temp.path, "foo");
		mkdirSync(repoPath, { recursive: true });
		git(repoPath, "init", "-q", "-b", "main");
		writeFileSync(join(repoPath, ".gitignore"), ".cline/\n");
		git(repoPath, "add", "-A");
		git(repoPath, "commit", "-q", "-m", "init");
		const configPath = getProjectKanbanConfigPath(repoPath);
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({ shortcuts: [{ label: "Preview", command: "npm run preview", icon: "play" }] }),
		);
		const entry = { workspaceId: "foo", repoPath };
		const deps = { homePath, resolveBaseBranch: async () => "main", now: () => new Date("2026-10-09T12:00:00Z") };
		return { homePath, repoPath, entry, deps };
	};

	it("before the import, says the repo copy will be imported once", async () => {
		const { entry, deps } = setup();
		const findings = await checkProjectShortcuts([entry], deps);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain("the next read imports them");
	});

	it("lists the imported shortcuts once for review, and reports the repo copy as ignored", async () => {
		const { homePath, repoPath, entry, deps } = setup();
		await readProjectShortcuts({ ...entry, homePath, resolveBaseBranch: deps.resolveBaseBranch });

		const first = await checkProjectShortcuts([entry], deps);
		expect(first.map((finding) => finding.level)).toEqual(["warn", "info"]);
		expect(first[0]?.message).toContain(
			`1 shortcut(s) imported from ${getProjectKanbanConfigPath(repoPath)} (the main checkout's working tree)`,
		);
		expect(first[0]?.message).toContain("    Preview: npm run preview");
		expect(first[1]?.message).toContain("it is ignored");
		expect((await readProjectShortcutStore("foo", homePath))?.imported.listedAt).toBe("2026-10-09T12:00:00.000Z");

		const second = await checkProjectShortcuts([entry], deps);
		expect(second.map((finding) => finding.level)).toEqual(["info"]);

		// Once the repo copy is gone, nothing is reported.
		writeFileSync(getProjectKanbanConfigPath(repoPath), JSON.stringify({}));
		expect(await checkProjectShortcuts([entry], deps)).toEqual([]);
	});

	it("fails on a store it can't read", async () => {
		const { homePath, entry, deps } = setup();
		const path = getProjectShortcutsPath("foo", homePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ not json");
		const findings = await checkProjectShortcuts([entry], deps);
		expect(findings.map((finding) => finding.level)).toEqual(["fail"]);
	});
});
