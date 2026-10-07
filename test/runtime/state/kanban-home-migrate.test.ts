import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { isManifestForStart } from "../../../src/pipeline/restart-recovery";
import {
	getCalibrationPaths,
	getKanbanBackupsPath,
	getKanbanModelsDataPath,
	getKanbanRunPath,
	getKanbanWorkspaceDataPath,
	getKanbanWorkspacesRootPath,
	getPipelineDecisionLogPath,
	getPipelineStatePath,
	getPricesDataPaths,
	getRestartManifestPath,
	getServerStartRecordPath,
	getWatchdogWorkspacePaths,
	resetKanbanHomeForTests,
	resolveKanbanHome,
} from "../../../src/state/kanban-home";
import {
	type HomeMigrateOptions,
	planKanbanHomeMigration,
	runKanbanHomeMigration,
} from "../../../src/state/kanban-home-migrate";
import { getKanbanServerLockPath, readProcessStartTime } from "../../../src/state/kanban-server-lock";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

interface Homes {
	legacyHome: string;
	targetHome: string;
	legacyWorktrees: string;
}

/** `--from` (required) and the old home's worktrees root, which its config.json doesn't name. */
function fromHome(userHomePath: string): Pick<HomeMigrateOptions, "fromPath" | "fromWorktreesPath"> {
	const { legacyHome, legacyWorktrees } = getHomes(userHomePath);
	return { fromPath: legacyHome, fromWorktreesPath: legacyWorktrees };
}

function getHomes(userHomePath: string): Homes {
	return {
		legacyHome: join(userHomePath, "old-home"),
		targetHome: join(userHomePath, ".kanban"),
		legacyWorktrees: join(userHomePath, "old-worktrees"),
	};
}

/** An old home like the pod's before the home move (worktrees outside it, as ~/.cline/worktrees was): config, one board, hooks, a trashed patch, and lock leftovers. */
function seedLegacyHome(userHomePath: string): void {
	const { legacyHome, legacyWorktrees } = getHomes(userHomePath);
	mkdirSync(legacyWorktrees, { recursive: true });
	writeJson(join(legacyHome, "config.json"), { selectedAgentId: "claude", readyForReviewNotificationsEnabled: false });
	writeJson(join(legacyHome, "workspaces", "index.json"), {
		version: 1,
		entries: { foo: { workspaceId: "foo", repoPath: "/projects/foo" } },
		repoPathToId: { "/projects/foo": "foo" },
	});
	writeJson(join(legacyHome, "workspaces", "foo", "board.json"), { columns: [], dependencies: [] });
	writeJson(join(legacyHome, "workspaces", "foo", "sessions.json"), {});
	writeJson(join(legacyHome, "workspaces", "foo", "meta.json"), { revision: 3, updatedAt: 1 });
	mkdirSync(join(legacyHome, "workspaces", "foo.lock"), { recursive: true });
	writeFileSync(join(legacyHome, "workspaces", "index.json.lock"), "", "utf8");
	writeJson(join(legacyHome, "hooks", "claude", "settings.json"), { hooks: {} });
	mkdirSync(join(legacyHome, "trashed-task-patches"), { recursive: true });
	writeFileSync(join(legacyHome, "trashed-task-patches", "abc12.patch"), "diff --git a/x b/x\n", "utf8");
}

/** A live process whose command line mentions kanban, standing in for a server. */
function startFakeServerProcess(): ChildProcess {
	return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "kanban-fake-server"], { stdio: "ignore" });
}

const noServer: HomeMigrateOptions["probeRuntimeServer"] = async () => null;

function listBackups(targetHome: string): string[] {
	const backupsDir = join(targetHome, "backups");
	return existsSync(backupsDir) ? readdirSync(backupsDir) : [];
}

function listTarball(path: string): string[] {
	const result = spawnSync("tar", ["-tzf", path], { encoding: "utf8" });
	expect(result.status).toBe(0);
	return result.stdout.split("\n").filter(Boolean);
}

describe("kanban home migrate", () => {
	it("copies the legacy home, marks the target and records the legacy worktree root", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { legacyHome, targetHome, legacyWorktrees } = getHomes(userHomePath);
				const sourceConfigBefore = readFileSync(join(legacyHome, "config.json"), "utf8");

				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
					now: () => new Date("2026-10-07T01:02:03.456Z"),
				});

				expect(result.plan.blockers).toEqual([]);
				expect(result.executed).toBe(true);
				expect(readJson(join(targetHome, "config.json"))).toEqual({
					selectedAgentId: "claude",
					readyForReviewNotificationsEnabled: false,
					home: 1,
					legacyWorktreeRoots: [legacyWorktrees],
				});
				for (const file of [
					"workspaces/index.json",
					"workspaces/foo/board.json",
					"workspaces/foo/sessions.json",
					"workspaces/foo/meta.json",
					"hooks/claude/settings.json",
					"trashed-task-patches/abc12.patch",
				]) {
					expect(readFileSync(join(targetHome, file), "utf8")).toBe(readFileSync(join(legacyHome, file), "utf8"));
				}
				// Locks belong to the process that took them.
				expect(existsSync(join(targetHome, "workspaces", "foo.lock"))).toBe(false);
				expect(existsSync(join(targetHome, "workspaces", "index.json.lock"))).toBe(false);
				// The source is never modified.
				expect(readFileSync(join(legacyHome, "config.json"), "utf8")).toBe(sourceConfigBefore);

				expect(result.backupPath).toBe(join(targetHome, "backups", "home-migrate-2026-10-07T01-02-03Z.tgz"));
				const entries = listTarball(result.backupPath ?? "");
				expect(entries.some((entry) => entry.endsWith("old-home/workspaces/foo/board.json"))).toBe(true);
				expect(entries.some((entry) => entry.endsWith("old-home/config.json"))).toBe(true);

				// The resolver now picks the migrated home and still finds the old worktrees.
				resetKanbanHomeForTests();
				const resolution = resolveKanbanHome();
				expect(resolution.source).toBe("default");
				expect(resolution.homePath).toBe(targetHome);
				expect(resolution.worktreesRootPath).toBe(join(targetHome, "worktrees"));
				expect(resolution.legacyWorktreeRootPaths).toEqual([legacyWorktrees]);
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("is idempotent: a second run has nothing to do and takes no backup", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { targetHome } = getHomes(userHomePath);
				await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});
				const configAfterFirst = readFileSync(join(targetHome, "config.json"), "utf8");
				expect(listBackups(targetHome)).toHaveLength(1);

				const second = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
					now: () => new Date("2030-01-01T00:00:00Z"),
				});
				expect(second.plan.upToDate).toBe(true);
				expect(second.executed).toBe(false);
				expect(second.plan.config.action).toBe("unchanged");
				expect(second.plan.files.every((file) => file.action === "unchanged")).toBe(true);
				expect(readFileSync(join(targetHome, "config.json"), "utf8")).toBe(configAfterFirst);
				expect(listBackups(targetHome)).toHaveLength(1);
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("--dry-run prints the plan and writes nothing", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { targetHome } = getHomes(userHomePath);
				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					dryRun: true,
					probeRuntimeServer: noServer,
				});
				expect(result.executed).toBe(false);
				expect(result.plan.config.action).toBe("create");
				expect(result.plan.files.filter((file) => file.action === "copy")).toHaveLength(6);
				expect(existsSync(targetHome)).toBe(false);
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("never overwrites target files: boards written on the new home win", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { targetHome, legacyWorktrees } = getHomes(userHomePath);
				const newerBoard = { columns: [{ id: "backlog", title: "Backlog", cards: [] }], dependencies: [] };
				writeJson(join(targetHome, "workspaces", "foo", "board.json"), newerBoard);
				writeJson(join(targetHome, "config.json"), { selectedAgentId: "codex", worktreesRoot: "/srv/worktrees" });

				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});

				expect(result.executed).toBe(true);
				expect(result.plan.files).toContainEqual({
					path: "workspaces/foo/board.json",
					kind: "file",
					action: "keep-target",
				});
				expect(readJson(join(targetHome, "workspaces", "foo", "board.json"))).toEqual(newerBoard);
				expect(result.plan.config.action).toBe("update");
				expect(result.plan.config.keptTargetKeys).toEqual(["selectedAgentId"]);
				expect(readJson(join(targetHome, "config.json"))).toEqual({
					selectedAgentId: "codex",
					readyForReviewNotificationsEnabled: false,
					worktreesRoot: "/srv/worktrees",
					home: 1,
					legacyWorktreeRoots: [legacyWorktrees],
				});
				expect(result.plan.worktreesRootPath).toBe("/srv/worktrees");
				// The backup holds the target's own files from before the run.
				const entries = listTarball(result.backupPath ?? "");
				expect(entries.some((entry) => entry.endsWith(".kanban/config.json"))).toBe(true);
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("refuses to migrate into ~/.kanban while it is the legacy dev-team kit repo", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { targetHome } = getHomes(userHomePath);
				const before = readdirSync(targetHome).sort();

				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});

				expect(result.executed).toBe(false);
				expect(result.plan.blockers.join("\n")).toContain("is a git repository");
				expect(readdirSync(targetHome).sort()).toEqual(before);
				expect(existsSync(join(targetHome, "config.json"))).toBe(false);
				expect(existsSync(join(targetHome, "workspaces"))).toBe(false);
			},
			{
				prepare: (userHomePath) => {
					seedLegacyHome(userHomePath);
					const kitRepo = join(userHomePath, ".kanban");
					for (const dir of [".git", "data/foo", "logs", "run", "backups", "bin"]) {
						mkdirSync(join(kitRepo, dir), { recursive: true });
					}
					writeJson(join(kitRepo, "kit.config.json"), { workspaces: {} });
				},
			},
		);
	});

	it("refuses while a Kanban server is running for the source or the target home", async () => {
		const server = startFakeServerProcess();
		try {
			await withTemporaryKanbanHome(
				async ({ userHomePath }) => {
					const { legacyHome, targetHome } = getHomes(userHomePath);
					const lockPath = getKanbanServerLockPath(targetHome);
					writeJson(lockPath, {
						pid: server.pid,
						url: "http://127.0.0.1:3485",
						homePath: targetHome,
						startedAt: 1,
						processStartTime: readProcessStartTime(server.pid ?? 0),
					});

					const result = await runKanbanHomeMigration({
						...fromHome(userHomePath),
						toPath: targetHome,
						probeRuntimeServer: noServer,
					});
					expect(result.executed).toBe(false);
					expect(result.plan.blockers).toHaveLength(1);
					expect(result.plan.blockers[0]).toContain(
						`A Kanban server (pid ${server.pid}, http://127.0.0.1:3485) is running for ${targetHome}`,
					);
					// The message says where the record is and how to tell it is stale.
					expect(result.plan.blockers[0]).toContain(lockPath);
					expect(result.plan.blockers[0]).toContain(`ps -p ${server.pid}`);
					expect(existsSync(getKanbanWorkspacesRootPath(targetHome))).toBe(false);
					expect(existsSync(join(legacyHome, "run"))).toBe(false);
				},
				{ prepare: seedLegacyHome },
			);
		} finally {
			server.kill();
		}
	});

	it("is not blocked by its own pid in a stale record (container restart: the server and migrate are both pid 2)", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { legacyHome, targetHome } = getHomes(userHomePath);
				writeJson(getKanbanServerLockPath(legacyHome), {
					pid: process.pid,
					url: "http://127.0.0.1:3485",
					homePath: legacyHome,
					startedAt: 1,
				});
				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});
				expect(result.plan.blockers).toEqual([]);
				expect(result.executed).toBe(true);
				// run/ is runtime state: not copied.
				expect(result.plan.ignoredEntries).toContain("run/");
				expect(existsSync(join(targetHome, "run"))).toBe(false);
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("does not leave a half-copied home the resolver would switch to (a file in the way of hooks/)", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { targetHome } = getHomes(userHomePath);
				mkdirSync(targetHome, { recursive: true });
				writeFileSync(join(targetHome, "hooks"), "", "utf8");

				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});

				expect(result.executed).toBe(false);
				expect(result.plan.blockers).toEqual([
					`${join(targetHome, "hooks")} is in the way: it is not a directory. Move it aside first.`,
				]);
				expect(readdirSync(targetHome)).toEqual(["hooks"]);
				resetKanbanHomeForTests();
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("rebuilds the staging dir left by an interrupted run and renames workspaces/ and config.json in last", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { legacyHome, targetHome } = getHomes(userHomePath);
				// An earlier run died while staging: the target has a partial staging dir and nothing else.
				const staging = join(targetHome, ".migrate-staging");
				writeJson(join(staging, "workspaces", "foo", "board.json"), { partial: true });
				writeFileSync(join(staging, "stray.txt"), "left over", "utf8");
				resetKanbanHomeForTests();

				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});

				expect(result.executed).toBe(true);
				expect(existsSync(staging)).toBe(false);
				expect(existsSync(join(targetHome, "stray.txt"))).toBe(false);
				expect(readFileSync(join(targetHome, "workspaces", "foo", "board.json"), "utf8")).toBe(
					readFileSync(join(legacyHome, "workspaces", "foo", "board.json"), "utf8"),
				);
				expect(readJson(join(targetHome, "config.json"))).toMatchObject({ home: 1 });
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("copies every top-level file (copilot-providers.json), keeps file modes and copies symlinks as symlinks", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { legacyHome, targetHome } = getHomes(userHomePath);
				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});

				expect(result.executed).toBe(true);
				expect(readJson(join(targetHome, "copilot-providers.json"))).toEqual({ providers: [{ id: "x" }] });
				expect(existsSync(join(targetHome, "server.lock"))).toBe(false);
				expect(statSync(join(targetHome, "hooks", "claude", "settings.json")).mode & 0o777).toBe(0o600);
				expect(lstatSync(join(targetHome, "hooks", "claude", "current")).isSymbolicLink()).toBe(true);
				expect(readlinkSync(join(targetHome, "hooks", "claude", "current"))).toBe("settings.json");
				expect(result.plan.ignoredEntries).toEqual(["run/"]);
				expect(existsSync(join(legacyHome, "copilot-providers.json"))).toBe(true);

				const again = await planKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});
				expect(again.upToDate).toBe(true);
			},
			{
				prepare: (userHomePath) => {
					seedLegacyHome(userHomePath);
					const { legacyHome } = getHomes(userHomePath);
					writeJson(join(legacyHome, "copilot-providers.json"), { providers: [{ id: "x" }] });
					writeFileSync(join(legacyHome, "server.lock"), "", "utf8");
					mkdirSync(join(legacyHome, "run"), { recursive: true });
					chmodSync(join(legacyHome, "hooks", "claude", "settings.json"), 0o600);
					symlinkSync("settings.json", join(legacyHome, "hooks", "claude", "current"));
				},
			},
		);
	});

	it("refuses when the runtime endpoint answers for one of the homes or cannot say which home it serves", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { legacyHome, targetHome } = getHomes(userHomePath);
				const origin = "http://127.0.0.1:3484";

				const sameHome = await planKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: async () => ({ origin, homePath: legacyHome }),
				});
				expect(sameHome.blockers).toEqual([
					`A Kanban server answers at ${origin} for ${legacyHome}. Stop it first.`,
				]);

				const unknownHome = await planKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: async () => ({ origin, homePath: null }),
				});
				expect(unknownHome.blockers).toEqual([
					`A Kanban server answers at ${origin} (its home is unknown). Stop it first.`,
				]);

				const otherHome = await planKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: async () => ({ origin, homePath: join(userHomePath, "other-home") }),
				});
				expect(otherHome.blockers).toEqual([]);
			},
			{ prepare: seedLegacyHome },
		);
	});

	it("requires --from: there is no default source home", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { targetHome } = getHomes(userHomePath);
			await expect(
				planKanbanHomeMigration({ fromPath: " ", toPath: targetHome, probeRuntimeServer: noServer }),
			).rejects.toThrow("The source home is required (--from <dir>).");
		});
	});

	it("refuses without legacy state, and when source and target overlap", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { legacyHome, targetHome } = getHomes(userHomePath);
			const empty = await planKanbanHomeMigration({
				...fromHome(userHomePath),
				toPath: targetHome,
				probeRuntimeServer: noServer,
			});
			expect(empty.blockers).toEqual([`${legacyHome} has no Kanban state (no config.json, no workspaces/).`]);

			const same = await planKanbanHomeMigration({
				fromPath: targetHome,
				toPath: targetHome,
				probeRuntimeServer: noServer,
			});
			expect(same.blockers[0]).toBe(`Source and target are the same directory (${targetHome}).`);

			const nested = await planKanbanHomeMigration({
				fromPath: legacyHome,
				toPath: join(legacyHome, "nested"),
				probeRuntimeServer: noServer,
			});
			expect(nested.blockers[0]).toContain("must not contain each other");
		});
	});
});

/** The old home's data/ (pipeline, watchdog, team kit, restart manifest) and its server start record. */
function seedLegacyData(userHomePath: string): void {
	const { legacyHome } = getHomes(userHomePath);
	writeJson(getPipelineStatePath("foo", legacyHome), { version: 1, cards: { abc12: { qaflow: {} } } });
	writeFileSync(getPipelineDecisionLogPath("foo", legacyHome), '{"kind":"qa_gate"}\n', "utf8");
	writeJson(getWatchdogWorkspacePaths("foo", legacyHome).runoffs, { groups: [] });
	writeFileSync(getWatchdogWorkspacePaths("foo", legacyHome).orchestratorPlan, "# plan\n", "utf8");
	writeFileSync(join(getKanbanWorkspaceDataPath("foo", legacyHome), "scoreboard.jsonl"), "{}\n", "utf8");
	writeJson(getPricesDataPaths(legacyHome).pricesJson, { models: {} });
	writeJson(join(getKanbanModelsDataPath(legacyHome), "lemonade.json"), { models: [] });
	writeJson(getRestartManifestPath("foo", legacyHome), {
		at: "2026-10-07T10:00:00.000Z",
		kanbanStart: "2026-10-07T09:00:00.000Z",
		cards: [],
	});
	writeJson(getServerStartRecordPath(legacyHome), { pid: 2, startedAt: Date.parse("2026-10-07T09:00:00.000Z") });
	// A calibration runner's pid lock belongs to that runner.
	const calibration = getCalibrationPaths("foo", "c1", legacyHome);
	writeJson(calibration.state, { finishedAt: null });
	writeFileSync(calibration.lock, "123", "utf8");
}

function setMtime(path: string, iso: string): void {
	const at = new Date(iso);
	utimesSync(path, at, at);
}

describe("kanban home migrate: data/ and the server start record", () => {
	it("copies data/ and run/server-start.json; other run/ files and pid locks stay behind", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { legacyHome, targetHome } = getHomes(userHomePath);
				const dry = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					dryRun: true,
					probeRuntimeServer: noServer,
				});
				const copied = dry.plan.files.filter((file) => file.action === "copy").map((file) => file.path);
				const relativeTo = (path: string) => relative(legacyHome, path);
				const expected = [
					relativeTo(getPipelineStatePath("foo", legacyHome)),
					relativeTo(getPipelineDecisionLogPath("foo", legacyHome)),
					relativeTo(getWatchdogWorkspacePaths("foo", legacyHome).runoffs),
					relativeTo(getWatchdogWorkspacePaths("foo", legacyHome).orchestratorPlan),
					relativeTo(join(getKanbanWorkspaceDataPath("foo", legacyHome), "scoreboard.jsonl")),
					relativeTo(getPricesDataPaths(legacyHome).pricesJson),
					relativeTo(join(getKanbanModelsDataPath(legacyHome), "lemonade.json")),
					relativeTo(getRestartManifestPath("foo", legacyHome)),
					relativeTo(getServerStartRecordPath(legacyHome)),
					relativeTo(getCalibrationPaths("foo", "c1", legacyHome).state),
				];
				expect(copied).toEqual(expect.arrayContaining(expected));
				expect(copied).not.toContain(relativeTo(getCalibrationPaths("foo", "c1", legacyHome).lock));
				expect(copied).not.toContain(relativeTo(join(getKanbanRunPath(legacyHome), "pid-pressure")));
				expect(existsSync(targetHome)).toBe(false);

				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});
				expect(result.executed).toBe(true);
				for (const path of expected) {
					expect(readFileSync(join(targetHome, path), "utf8")).toBe(readFileSync(join(legacyHome, path), "utf8"));
				}
				expect(existsSync(join(getKanbanRunPath(targetHome), "pid-pressure"))).toBe(false);
				expect(existsSync(getCalibrationPaths("foo", "c1", targetHome).lock)).toBe(false);

				// Restart recovery on the new home matches the old server's manifest through the copied start record.
				const record = readJson(getServerStartRecordPath(targetHome)) as { startedAt: number };
				const manifest = readJson(getRestartManifestPath("foo", targetHome)) as Parameters<
					typeof isManifestForStart
				>[0];
				expect(isManifestForStart(manifest, Date.parse("2026-10-07T10:05:00.000Z"), record.startedAt)).toBe(true);

				const again = await planKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});
				expect(again.upToDate).toBe(true);
			},
			{
				prepare: (userHomePath) => {
					seedLegacyHome(userHomePath);
					seedLegacyData(userHomePath);
					writeFileSync(join(getKanbanRunPath(getHomes(userHomePath).legacyHome), "pid-pressure"), "", "utf8");
				},
			},
		);
	});

	it("keeps a newer target file (a conflict), replaces an older one and saves the target's version to backups", async () => {
		await withTemporaryKanbanHome(
			async ({ userHomePath }) => {
				const { legacyHome, targetHome } = getHomes(userHomePath);
				const statePath = relative(legacyHome, getPipelineStatePath("foo", legacyHome));
				const logPath = relative(legacyHome, getPipelineDecisionLogPath("foo", legacyHome));
				const startPath = relative(legacyHome, getServerStartRecordPath(legacyHome));
				// The target's pipeline state was written after the source's: it wins.
				writeJson(join(targetHome, statePath), { version: 1, cards: { newer: {} } });
				setMtime(join(legacyHome, statePath), "2026-10-07T09:00:00Z");
				setMtime(join(targetHome, statePath), "2026-10-07T11:00:00Z");
				// The target's decision log and start record are older than the source's: replaced.
				writeFileSync(join(targetHome, logPath), '{"kind":"old"}\n', "utf8");
				setMtime(join(targetHome, logPath), "2026-10-06T09:00:00Z");
				setMtime(join(legacyHome, logPath), "2026-10-07T09:00:00Z");
				writeJson(join(targetHome, startPath), { pid: 7, startedAt: 1 });
				setMtime(join(targetHome, startPath), "2026-10-06T09:00:00Z");
				setMtime(join(legacyHome, startPath), "2026-10-07T09:00:00Z");
				// Board files keep the old rule: the target's is never overwritten, even when older.
				writeJson(join(targetHome, "workspaces", "foo", "board.json"), {
					columns: [{ id: "x" }],
					dependencies: [],
				});
				setMtime(join(targetHome, "workspaces", "foo", "board.json"), "2020-01-01T00:00:00Z");

				const dry = await planKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
					now: () => new Date("2026-10-07T12:00:00Z"),
				});
				const actionOf = (path: string) => dry.files.find((file) => file.path === path)?.action;
				expect(actionOf(statePath)).toBe("keep-target");
				expect(actionOf(logPath)).toBe("replace");
				expect(actionOf(startPath)).toBe("replace");
				expect(actionOf("workspaces/foo/board.json")).toBe("keep-target");

				const result = await runKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
					now: () => new Date("2026-10-07T12:00:00Z"),
				});
				expect(result.executed).toBe(true);
				expect(readJson(join(targetHome, statePath))).toEqual({ version: 1, cards: { newer: {} } });
				expect(readFileSync(join(targetHome, logPath), "utf8")).toBe('{"kind":"qa_gate"}\n');
				expect(readJson(join(targetHome, startPath))).toEqual(readJson(join(legacyHome, startPath)));
				expect(readJson(join(targetHome, "workspaces", "foo", "board.json"))).toEqual({
					columns: [{ id: "x" }],
					dependencies: [],
				});
				const replacedDir = join(getKanbanBackupsPath(targetHome), "home-migrate-2026-10-07T12-00-00Z");
				expect(result.plan.replacedBackupPath).toBe(replacedDir);
				expect(readFileSync(join(replacedDir, logPath), "utf8")).toBe('{"kind":"old"}\n');
				expect(readJson(join(replacedDir, startPath))).toEqual({ pid: 7, startedAt: 1 });
				expect(existsSync(join(replacedDir, statePath))).toBe(false);
				// The source is never modified.
				expect(readFileSync(join(legacyHome, logPath), "utf8")).toBe('{"kind":"qa_gate"}\n');

				// Copies keep the source's mtime, so a re-run sees the replaced files as unchanged.
				const again = await planKanbanHomeMigration({
					...fromHome(userHomePath),
					toPath: targetHome,
					probeRuntimeServer: noServer,
				});
				expect(again.files.find((file) => file.path === statePath)?.action).toBe("keep-target");
				expect(again.upToDate).toBe(true);
			},
			{
				prepare: (userHomePath) => {
					seedLegacyHome(userHomePath);
					seedLegacyData(userHomePath);
				},
			},
		);
	});
});
