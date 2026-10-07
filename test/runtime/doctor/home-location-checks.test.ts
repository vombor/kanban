import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkHomeLocation } from "../../../src/doctor/home-location-checks";
import { createTempDir } from "../../utilities/temp-dir";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value), "utf8");
}

/** `<root>/<taskId>/<repo>` with a `.git` file, as `git worktree add` leaves it. */
function addWorktree(root: string, taskId: string, repo = "kanban"): string {
	const path = join(root, taskId, repo);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, ".git"), `gitdir: /projects/${repo}/.git/worktrees/${taskId}\n`, "utf8");
	return path;
}

describe("checkHomeLocation", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function setup() {
		const { path: userHome, cleanup } = createTempDir("kanban-doctor-home-location-");
		cleanups.push(cleanup);
		const homePath = join(userHome, ".kanban");
		const clineDirPath = join(userHome, ".cline");
		mkdirSync(homePath, { recursive: true });
		// What the Cline CLI keeps there: never reported.
		mkdirSync(join(clineDirPath, "data", "sessions"), { recursive: true });
		mkdirSync(join(clineDirPath, "rules"), { recursive: true });
		return { userHome, homePath, clineDirPath, configPath: join(homePath, "config.json") };
	}

	it("reports nothing for a home with only Cline's own files in ~/.cline", async () => {
		const { homePath, clineDirPath, configPath } = setup();
		expect(await checkHomeLocation({ homePath, configPath, legacyWorktreeRootPaths: [], clineDirPath })).toEqual([]);
	});

	it("warns while config.json lists a legacy worktree root, with the worktrees left there", async () => {
		const { homePath, clineDirPath, configPath } = setup();
		const oldRoot = join(clineDirPath, "worktrees");
		addWorktree(oldRoot, "277f8");
		const findings = await checkHomeLocation({
			homePath,
			configPath,
			legacyWorktreeRootPaths: [oldRoot],
			clineDirPath,
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ level: "warn", area: "home" });
		expect(findings[0]?.message).toContain(`legacyWorktreeRoots lists ${oldRoot} (1 task worktree(s) there)`);
		expect(findings[0]?.hint).toContain("once those cards are Done");
	});

	it("warns about Kanban homes, pipeline state and task worktrees under ~/.cline", async () => {
		const { homePath, clineDirPath, configPath } = setup();
		const renamed = join(clineDirPath, "kanban.migrated-20261007T180526Z");
		mkdirSync(join(renamed, "workspaces", "kanban-2uge"), { recursive: true });
		writeJson(join(renamed, "workspaces", "kanban-2uge", "board.json"), { columns: [] });
		const marked = join(clineDirPath, "kanban");
		mkdirSync(marked, { recursive: true });
		writeJson(join(marked, "config.json"), { home: 1 });
		const stray = join(clineDirPath, "stray");
		mkdirSync(join(stray, "data", "foo"), { recursive: true });
		writeJson(join(stray, "data", "foo", "pipeline-state.json"), { version: 1, cards: {} });
		addWorktree(join(clineDirPath, "worktrees"), "abc12");

		const findings = await checkHomeLocation({ homePath, configPath, legacyWorktreeRootPaths: [], clineDirPath });
		expect(findings.map((finding) => [finding.level, finding.message])).toEqual([
			["warn", `${marked} holds a Kanban home inside the Cline CLI's directory; Kanban does not use it`],
			[
				"warn",
				`${renamed} holds a Kanban home (1 board(s)) inside the Cline CLI's directory; Kanban does not use it`,
			],
			["warn", `${stray} holds Kanban pipeline state inside the Cline CLI's directory; Kanban does not use it`],
			[
				"warn",
				`${join(clineDirPath, "worktrees")} holds 1 Kanban task worktree(s) inside the Cline CLI's directory; Kanban does not use it`,
			],
		]);
	});

	it("reports a configured legacy root under ~/.cline once, and a home inside ~/.cline", async () => {
		const { clineDirPath, configPath } = setup();
		const oldRoot = join(clineDirPath, "worktrees");
		addWorktree(oldRoot, "277f8");
		const homePath = join(clineDirPath, "kanban");
		mkdirSync(join(homePath, "workspaces"), { recursive: true });
		writeJson(join(homePath, "workspaces", "index.json"), {});
		const findings = await checkHomeLocation({
			homePath,
			configPath,
			legacyWorktreeRootPaths: [oldRoot],
			clineDirPath,
		});
		expect(findings.map((finding) => finding.message)).toEqual([
			expect.stringContaining(`legacyWorktreeRoots lists ${oldRoot}`),
			`the Kanban home ${homePath} is inside ${clineDirPath}, which belongs to the Cline CLI`,
		]);
	});
});
