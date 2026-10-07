// `kanban project rename-id` (src/projects/project-rename-id.ts) on temporary Kanban homes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyCliSessionScope } from "../../../src/isolation/cli-scope";
import { KANBAN_SESSION_CREDENTIAL_ENV } from "../../../src/isolation/session-identity";
import {
	describeInvalidWorkspaceId,
	type ProjectRenameIdOptions,
	runProjectIdRename,
} from "../../../src/projects/project-rename-id";
import {
	getBoardBackupsPath,
	getCalibrationPaths,
	getIsolationWorkspacePaths,
	getKanbanBackupsPath,
	getKanbanGlobalConfigPath,
	getKanbanHomePath,
	getKanbanWorkspaceDataPath,
	getKanbanWorkspaceIndexPath,
	getKanbanWorkspaceStatePath,
	getPipelineDecisionLogPath,
	getPipelineStatePath,
	getProjectRenameJournalPath,
	getRestartRecoverRequestPath,
} from "../../../src/state/kanban-home";
import { getKanbanServerLockPath, readProcessStartTime } from "../../../src/state/kanban-server-lock";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const BACKUP_NAME = "rename-id-2026-10-07T12-00-00Z";

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function writeText(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function summary(taskId: string): Record<string, unknown> {
	return { taskId, state: "idle", workspacePath: "/projects/kanban", updatedAt: 1 };
}

/** Two projects, `kanban-2uge` (the one renamed) and `foo`, with the state a live home has. */
function seedHome(): void {
	const home = getKanbanHomePath();
	writeJson(getKanbanWorkspaceIndexPath(home), {
		version: 1,
		entries: {
			"kanban-2uge": { workspaceId: "kanban-2uge", repoPath: "/projects/kanban" },
			foo: { workspaceId: "foo", repoPath: "/projects/foo" },
		},
		repoPathToId: { "/projects/kanban": "kanban-2uge", "/projects/foo": "foo" },
	});
	writeJson(getKanbanGlobalConfigPath(), {
		selectedAgentId: "claude",
		orchestrator: { wake: { enabled: true, mode: "sidebar", target: "kanban-2uge" } },
		workspaces: {
			"kanban-2uge": { name: "Kanban", landing: { mode: "off" }, isolation: { messages: "allow" } },
			foo: { landing: { mode: "off" } },
		},
		home: 1,
	});
	const board = { columns: [{ id: "in_progress", cards: [{ id: "abc12", title: "card" }] }], dependencies: [] };
	writeJson(join(getKanbanWorkspaceStatePath("kanban-2uge", home), "board.json"), board);
	writeJson(join(getKanbanWorkspaceStatePath("kanban-2uge", home), "sessions.json"), {
		abc12: summary("abc12"),
		"__home_agent__:kanban-2uge:claude": summary("__home_agent__:kanban-2uge:claude"),
	});
	writeJson(join(getKanbanWorkspaceStatePath("foo", home), "board.json"), board);
	// A home-agent summary can sit in another workspace's sessions.json.
	writeJson(join(getKanbanWorkspaceStatePath("foo", home), "sessions.json"), {
		"__home_agent__:kanban-2uge:claude": summary("__home_agent__:kanban-2uge:claude"),
		"__home_agent__:foo:claude": summary("__home_agent__:foo:claude"),
	});
	writeJson(getPipelineStatePath("kanban-2uge", home), { version: 1, since: "x", importedFrom: null, cards: {} });
	writeText(getPipelineDecisionLogPath("kanban-2uge", home), '{"workspaceId":"kanban-2uge","taskId":"abc12"}\n');
	writeText(
		join(getKanbanWorkspaceDataPath("kanban-2uge", home), "notes.sh"),
		"cat ~/.kanban/data/kanban-2uge/qa-log.md\n",
	);
	const message = { id: "m-1", at: "t", fromWorkspaceId: "foo", toWorkspaceId: "kanban-2uge", kind: "request" };
	writeText(getIsolationWorkspacePaths("foo", home).messages, `${JSON.stringify(message)}\n`);
	writeText(getIsolationWorkspacePaths("kanban-2uge", home).messages, `${JSON.stringify(message)}\n`);
	writeJson(getCalibrationPaths("kanban-2uge", "c1", home).spec, { name: "c1", workspace: "kanban-2uge" });
	writeJson(join(getBoardBackupsPath("kanban-2uge", home), "board-1.json"), board);
	writeText(
		getRestartRecoverRequestPath(home),
		"2026-10-07T11:00:00.000Z kanban-2uge\n2026-10-07T11:00:01.000Z foo\n",
	);
}

function options(overrides: Partial<ProjectRenameIdOptions> = {}): ProjectRenameIdOptions {
	return { fromId: "kanban-2uge", toId: "kanban", now: () => NOW, probeRuntimeServer: async () => null, ...overrides };
}

function expectRenamed(): void {
	const home = getKanbanHomePath();
	expect(readJson(getKanbanWorkspaceIndexPath(home))).toEqual({
		version: 1,
		entries: {
			kanban: { workspaceId: "kanban", repoPath: "/projects/kanban" },
			foo: { workspaceId: "foo", repoPath: "/projects/foo" },
		},
		repoPathToId: { "/projects/kanban": "kanban", "/projects/foo": "foo" },
	});
	const config = readJson(getKanbanGlobalConfigPath()) as {
		workspaces: Record<string, unknown>;
		orchestrator: { wake: { target: string } };
	};
	expect(Object.keys(config.workspaces)).toEqual(["kanban", "foo"]);
	expect(config.workspaces.kanban).toEqual({
		name: "Kanban",
		landing: { mode: "off" },
		isolation: { messages: "allow" },
	});
	expect(config.orchestrator.wake.target).toBe("kanban");
	expect(existsSync(getKanbanWorkspaceStatePath("kanban-2uge", home))).toBe(false);
	expect(existsSync(getKanbanWorkspaceDataPath("kanban-2uge", home))).toBe(false);
	expect(existsSync(getBoardBackupsPath("kanban-2uge", home))).toBe(false);
	expect(existsSync(join(getBoardBackupsPath("kanban", home), "board-1.json"))).toBe(true);
	expect(readJson(join(getKanbanWorkspaceStatePath("kanban", home), "sessions.json"))).toEqual({
		abc12: summary("abc12"),
		"__home_agent__:kanban:claude": summary("__home_agent__:kanban:claude"),
	});
	expect(readJson(join(getKanbanWorkspaceStatePath("foo", home), "sessions.json"))).toEqual({
		"__home_agent__:kanban:claude": summary("__home_agent__:kanban:claude"),
		"__home_agent__:foo:claude": summary("__home_agent__:foo:claude"),
	});
	expect(readJson(getPipelineStatePath("kanban", home))).toMatchObject({ cards: {} });
	// History stays as written.
	expect(readFileSync(getPipelineDecisionLogPath("kanban", home), "utf8")).toContain('"workspaceId":"kanban-2uge"');
	for (const workspaceId of ["foo", "kanban"]) {
		expect(JSON.parse(readFileSync(getIsolationWorkspacePaths(workspaceId, home).messages, "utf8"))).toMatchObject({
			fromWorkspaceId: "foo",
			toWorkspaceId: "kanban",
		});
	}
	expect(readJson(getCalibrationPaths("kanban", "c1", home).spec)).toEqual({ name: "c1", workspace: "kanban" });
	expect(readFileSync(getRestartRecoverRequestPath(home), "utf8")).toBe(
		"2026-10-07T11:00:00.000Z kanban\n2026-10-07T11:00:01.000Z foo\n",
	);
	expect(existsSync(getProjectRenameJournalPath(home))).toBe(false);
}

function snapshotTree(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else {
				files[path.slice(root.length)] = readFileSync(path, "utf8");
			}
		}
	};
	walk(root);
	return files;
}

describe("kanban project rename-id", () => {
	it("renames a project: index, dirs, config, session ids, messages, calibration specs, restart requests", async () => {
		await withTemporaryKanbanHome(async () => {
			seedHome();
			const result = await runProjectIdRename(options());
			expect(result.plan.blockers).toEqual([]);
			expect(result.executed).toBe(true);
			expect(result.plan.mentions).toEqual(["data/kanban-2uge/notes.sh"]);
			expectRenamed();

			const backupPath = join(getKanbanBackupsPath(getKanbanHomePath()), `${BACKUP_NAME}.tgz`);
			expect(result.backupPath).toBe(backupPath);
			const listing = spawnSync("tar", ["-tzf", backupPath], { encoding: "utf8" }).stdout;
			expect(listing).toContain("config.json");
			expect(listing).toContain("workspaces/index.json");
			expect(listing).toContain("data/kanban-2uge/pipeline-state.json");
			expect(listing).toContain("data/foo/messages.jsonl");

			// A rerun has nothing left to do.
			const again = await runProjectIdRename(options());
			expect(again.plan.upToDate).toBe(true);
			expect(again.executed).toBe(false);
		});
	});

	it("dry-run lists every move and rewrite and writes nothing", async () => {
		await withTemporaryKanbanHome(async () => {
			seedHome();
			const home = getKanbanHomePath();
			const before = snapshotTree(home);
			const result = await runProjectIdRename(options({ dryRun: true }));
			expect(result.executed).toBe(false);
			expect(snapshotTree(home)).toEqual(before);
			expect(result.plan.steps.filter((step) => step.kind === "move")).toEqual([
				{ kind: "move", from: "workspaces/kanban-2uge", to: "workspaces/kanban", done: false },
				{ kind: "move", from: "data/kanban-2uge", to: "data/kanban", done: false },
				{ kind: "move", from: "backups/boards/kanban-2uge", to: "backups/boards/kanban", done: false },
			]);
			expect(result.plan.rewrites.map((rewrite) => rewrite.file)).toEqual([
				"workspaces/foo/sessions.json",
				"workspaces/kanban-2uge/sessions.json",
				"data/foo/messages.jsonl",
				"data/kanban-2uge/messages.jsonl",
				"data/kanban-2uge/calibration/c1/spec.json",
				"run/restart-recover.now",
				"config.json",
				"workspaces/index.json",
			]);
			expect(result.plan.rewrites.find((rewrite) => rewrite.file === "config.json")?.detail).toBe(
				"workspaces.kanban-2uge → workspaces.kanban; orchestrator.wake.target kanban-2uge → kanban",
			);
		});
	});

	it("refuses a leftover dir at the new id without --move-aside, and moves it to backups with it", async () => {
		await withTemporaryKanbanHome(async () => {
			seedHome();
			const home = getKanbanHomePath();
			// The retired kit board's leftover data (data/kanban in the pod).
			writeJson(join(getKanbanWorkspaceDataPath("kanban", home), "restart-manifest.json"), { at: "old", cards: [] });
			writeJson(join(getKanbanWorkspaceStatePath("foo", home), "sessions.json"), {
				"__home_agent__:kanban-2uge:claude": summary("__home_agent__:kanban-2uge:claude"),
				"__home_agent__:kanban:codex": summary("__home_agent__:kanban:codex"),
			});

			const refused = await runProjectIdRename(options());
			expect(refused.executed).toBe(false);
			expect(refused.plan.blockers).toHaveLength(1);
			expect(refused.plan.blockers[0]).toContain("kanban is not a registered project, but its state is still here");
			expect(refused.plan.blockers[0]).toContain("data/kanban");
			expect(refused.plan.blockers[0]).toContain("__home_agent__:kanban:codex");
			expect(refused.plan.blockers[0]).toContain("--move-aside");
			expect(existsSync(getKanbanWorkspaceStatePath("kanban-2uge", home))).toBe(true);

			const result = await runProjectIdRename(options({ moveAside: true }));
			expect(result.plan.blockers).toEqual([]);
			expect(result.executed).toBe(true);
			const aside = join(getKanbanBackupsPath(home), BACKUP_NAME);
			expect(readJson(join(aside, "data", "kanban", "restart-manifest.json"))).toEqual({ at: "old", cards: [] });
			expect(readJson(join(aside, "home-agent-sessions.json"))).toEqual({
				"workspaces/foo/sessions.json": {
					"__home_agent__:kanban:codex": summary("__home_agent__:kanban:codex"),
				},
			});
			expect(existsSync(join(getKanbanWorkspaceDataPath("kanban", home), "restart-manifest.json"))).toBe(false);
			expect(readJson(join(getKanbanWorkspaceStatePath("foo", home), "sessions.json"))).toEqual({
				"__home_agent__:kanban:claude": summary("__home_agent__:kanban:claude"),
			});
		});
	});

	it("finishes an interrupted run when rerun", async () => {
		await withTemporaryKanbanHome(async () => {
			seedHome();
			const home = getKanbanHomePath();
			// Crashes after the data dir moved, before that step was marked done.
			await expect(
				runProjectIdRename(
					options({
						afterStep: (step) => {
							if (step.kind === "move" && step.from === "data/kanban-2uge") {
								throw new Error("killed");
							}
						},
					}),
				),
			).rejects.toThrow("killed");
			expect(existsSync(getProjectRenameJournalPath(home))).toBe(true);
			expect(existsSync(getKanbanWorkspaceDataPath("kanban", home))).toBe(true);
			// Still registered under the old id: the index is rewritten last.
			expect(Object.keys((readJson(getKanbanWorkspaceIndexPath(home)) as { entries: object }).entries)).toContain(
				"kanban-2uge",
			);

			// Another rename waits for this one.
			const other = await runProjectIdRename(options({ fromId: "foo", toId: "bar" }));
			expect(other.plan.blockers.join("\n")).toContain("An earlier rename kanban-2uge → kanban didn't finish");

			// Crashes again in the middle of the rewrites.
			await expect(
				runProjectIdRename(
					options({
						now: () => new Date("2026-10-07T13:00:00.000Z"),
						afterStep: (step) => {
							if (step.kind === "rewrite" && step.target === "config") {
								throw new Error("killed again");
							}
						},
					}),
				),
			).rejects.toThrow("killed again");

			const result = await runProjectIdRename(options({ now: () => new Date("2026-10-07T14:00:00.000Z") }));
			expect(result.plan.resumed).toBe(true);
			expect(result.plan.blockers).toEqual([]);
			expect(result.executed).toBe(true);
			// One backup, taken before the first change.
			expect(result.backupPath).toBe(join(getKanbanBackupsPath(home), `${BACKUP_NAME}.tgz`));
			expect(readdirSync(getKanbanBackupsPath(home)).filter((name) => name.endsWith(".tgz"))).toEqual([
				`${BACKUP_NAME}.tgz`,
			]);
			expectRenamed();
		});
	});

	it("refuses while a Kanban server runs on the home", async () => {
		await withTemporaryKanbanHome(async () => {
			seedHome();
			const home = getKanbanHomePath();
			// Any live process other than this one counts (the parent of the test worker).
			writeJson(getKanbanServerLockPath(home), {
				pid: process.ppid,
				url: "http://127.0.0.1:3484",
				homePath: home,
				startedAt: 1,
				processStartTime: readProcessStartTime(process.ppid),
			});
			const locked = await runProjectIdRename(options());
			expect(locked.executed).toBe(false);
			expect(locked.plan.blockers.join("\n")).toContain(`A Kanban server (pid ${process.ppid}`);

			writeFileSync(getKanbanServerLockPath(home), "", "utf8");
			const answering = await runProjectIdRename(
				options({ probeRuntimeServer: async () => ({ origin: "http://127.0.0.1:3484", homePath: home }) }),
			);
			expect(answering.executed).toBe(false);
			expect(answering.plan.blockers).toEqual([
				`A Kanban server answers at http://127.0.0.1:3484 for ${home}. Stop it first.`,
			]);
			expect(existsSync(getKanbanWorkspaceStatePath("kanban-2uge", home))).toBe(true);
		});
	});

	it("refuses an invalid, reserved or used new id and an unregistered old one", async () => {
		await withTemporaryKanbanHome(async () => {
			seedHome();
			expect(describeInvalidWorkspaceId("kanban")).toBeNull();
			for (const toId of ["Kanban", "a_b", "-a", "a--b", "a:b", "models", "prices"]) {
				expect(describeInvalidWorkspaceId(toId)).not.toBeNull();
			}
			const used = await runProjectIdRename(options({ toId: "foo" }));
			expect(used.plan.blockers).toEqual(["foo is already the id of a registered project (/projects/foo)."]);
			const missing = await runProjectIdRename(options({ fromId: "nope" }));
			expect(missing.plan.blockers).toEqual(["nope is not a registered project."]);
			const invalid = await runProjectIdRename(options({ toId: "Bad Id" }));
			expect(invalid.plan.blockers[0]).toContain("is not a valid workspace id");
			expect(existsSync(getKanbanWorkspaceStatePath("kanban-2uge", getKanbanHomePath()))).toBe(true);
		});
	});

	it("is refused from an agent session in every isolation mode", async () => {
		await withTemporaryKanbanHome(async () => {
			for (const mode of ["off", "report", "enforce"]) {
				writeJson(getKanbanGlobalConfigPath(), { isolation: { mode } });
				const refusal = await applyCliSessionScope({
					commandPath: "project rename-id",
					options: {},
					createClient: () => {
						throw new Error("no server");
					},
					env: { [KANBAN_SESSION_CREDENTIAL_ENV]: "c".repeat(64) },
				});
				expect(refusal).toContain("`kanban project rename-id` is the user's");
			}
		});
	});
});
