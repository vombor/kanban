import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkUncleanStopDamage } from "../../../src/doctor/unclean-stop-checks";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, env: createGitTestEnv() });
}

describe("doctor: damage an unclean stop left (issue #36)", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	const setup = () => {
		const temp = createTempDir("kanban-doctor-unclean-");
		temps.push(temp);
		const repoPath = join(temp.path, "notes");
		mkdirSync(repoPath, { recursive: true });
		git(repoPath, "init", "-q", "-b", "main");
		writeFileSync(join(repoPath, "a.txt"), "a\n");
		git(repoPath, "add", "-A");
		git(repoPath, "commit", "-q", "-m", "init");
		const statePath = join(temp.path, "data", "notes", "pipeline-state.json");
		mkdirSync(join(temp.path, "data", "notes"), { recursive: true });
		return { repoPath, statePath, entries: [{ workspaceId: "notes", repoPath }] };
	};

	it("passes for a readable state file and index", async () => {
		const { statePath, entries } = setup();
		writeFileSync(statePath, JSON.stringify({ version: 1, since: "x", importedFrom: null, cards: {} }));
		expect(await checkUncleanStopDamage(entries, { getStatePath: () => statePath })).toEqual([
			expect.objectContaining({ level: "pass" }),
		]);
	});

	it("warns about an empty pipeline-state.json and an unreadable index, and changes neither", async () => {
		const { repoPath, statePath, entries } = setup();
		writeFileSync(statePath, "");
		const indexPath = join(repoPath, ".git", "index");
		writeFileSync(indexPath, "");
		const findings = await checkUncleanStopDamage(entries, { getStatePath: () => statePath });
		expect(findings.map((finding) => finding.level)).toEqual(["warn", "warn"]);
		expect(findings[0]?.message).toContain(`${statePath} is empty (0 bytes)`);
		expect(findings[1]?.message).toContain(`git can't read the index of ${repoPath}`);
		expect(findings[1]?.message).toContain("index file smaller than expected");
		expect(findings[1]?.hint).toContain("read-tree HEAD");
		expect(findings.some((finding) => finding.fix)).toBe(false);
		expect(readFileSync(statePath, "utf8")).toBe("");
		expect(readFileSync(indexPath, "utf8")).toBe("");
	});
});
