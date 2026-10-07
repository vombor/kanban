import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeProcessReaperSettings } from "../../../src/core/api-contract";
import { createOrphanProcessSweeper, type WorkspaceBoardSnapshot } from "../../../src/server/orphan-process-sweeper";
import { createProcessReaper } from "../../../src/server/process-reaper";
import { connectLoopback, createFakeProcessTable, createProcessEntry } from "../../utilities/fake-process-table";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const SERVER_PID = 500;
const ROOT = "/kanban-test-worktrees";
const LEGACY_ROOT = "/kanban-test-legacy-worktrees";

const FOO: WorkspaceBoardSnapshot = {
	workspaceId: "foo",
	repoPath: "/projects/foo",
	board: createBoard({
		in_progress: [createCard({ id: "act01" })],
		trash: [createCard({ id: "don01" })],
	}),
};

function createHarness(
	entries: Parameters<typeof createFakeProcessTable>[0],
	options: {
		workspaces?: WorkspaceBoardSnapshot[];
		settings?: Partial<RuntimeProcessReaperSettings>;
		existingPaths?: string[];
		/** Replaces the default init + server processes. */
		baseEntries?: Parameters<typeof createFakeProcessTable>[0];
		serverPid?: number;
	} = {},
) {
	const table = createFakeProcessTable([
		...(options.baseEntries ?? [
			createProcessEntry({ pid: 1, ppid: 0, command: "init", cwd: "/" }),
			createProcessEntry({ pid: SERVER_PID, ppid: 1, command: "kanban", cwd: "/home/dev" }),
		]),
		...entries,
	]);
	const log = vi.fn();
	const settings: RuntimeProcessReaperSettings = {
		enabled: true,
		intervalSec: 300,
		mode: "terminate",
		...options.settings,
	};
	const loadSettings = vi.fn(async () => settings);
	const existing = new Set(options.existingPaths ?? []);
	const sweeper = createOrphanProcessSweeper({
		reaper: createProcessReaper({
			reader: table.reader,
			signal: table.signal,
			serverPid: options.serverPid ?? SERVER_PID,
			pollMs: 100,
			getWorktreeRoots: () => [ROOT, LEGACY_ROOT],
		}),
		getWorktreeRoots: () => [ROOT, LEGACY_ROOT],
		listWorkspaceBoards: async () => options.workspaces ?? [FOO],
		loadSettings,
		log,
		pathExists: (path) => existing.has(path),
		now: () => 1_000,
	});
	return { table, sweeper, log, loadSettings, settings };
}

describe("orphan process sweeper", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("terminates processes of Done cards and leaves active cards and paths outside the roots alone", async () => {
		const { table, sweeper, log } = createHarness(
			[
				createProcessEntry({ pid: 10, cwd: `${ROOT}/act01/foo`, command: "claude" }),
				createProcessEntry({ pid: 11, cwd: `${ROOT}/don01/foo`, command: "npm run dev:servers" }),
				createProcessEntry({ pid: 12, cwd: `${LEGACY_ROOT}/don01/foo/web-ui`, command: "tsx preview" }),
				createProcessEntry({ pid: 13, cwd: "/projects/foo", command: "dev server in the main checkout" }),
				createProcessEntry({ pid: 14, cwd: ROOT, command: "shell in the root itself" }),
			],
			{ existingPaths: [`${ROOT}/act01/foo`, `${ROOT}/don01/foo`] },
		);

		const result = await sweeper.sweep();

		expect(result.orphans).toEqual([
			expect.objectContaining({ pid: 11, taskId: "don01", reason: "card_done", action: "terminated" }),
			expect.objectContaining({ pid: 12, taskId: "don01", reason: "card_done", action: "terminated" }),
		]);
		expect(table.signals.map((entry) => entry.pid).sort()).toEqual([11, 12]);
		expect([...table.processes.keys()]).toEqual(expect.arrayContaining([10, 13, 14]));
		expect(result.processCount).toBe(3);
		expect(result.cards).toEqual(
			expect.arrayContaining([
				{ taskId: "act01", workspaceId: "foo", status: "active", processCount: 1, rssBytes: 10 * 1024 * 1024 },
				{ taskId: "don01", workspaceId: "foo", status: "done", processCount: 2, rssBytes: 20 * 1024 * 1024 },
			]),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("terminated orphan pid 11 of card don01 (card_done, 10.0 MB): npm run dev:servers"),
		);
		expect((await sweeper.getStatus()).lastSweep).toEqual(result);
	});

	it("terminates a deleted-cwd process of a Done card, but not an active card's process in a deleted subdirectory", async () => {
		const { table, sweeper } = createHarness(
			[
				// The Done card's worktree is gone.
				createProcessEntry({ pid: 20, cwd: `${ROOT}/don01/foo`, cwdDeleted: true, command: "tail -f dev.log" }),
				// Active card, worktree still there: only a subdirectory was rebuilt.
				createProcessEntry({ pid: 21, cwd: `${ROOT}/act01/foo/dist`, cwdDeleted: true, command: "vite preview" }),
			],
			{ existingPaths: [`${ROOT}/act01/foo`] },
		);

		const result = await sweeper.sweep();

		expect(result.orphans).toEqual([
			expect.objectContaining({
				pid: 20,
				taskId: "don01",
				reason: "worktree_deleted",
				action: "terminated",
				eligible: true,
			}),
		]);
		expect(table.processes.has(21)).toBe(true);
	});

	it("only reports a deleted cwd when the card is on no board, on an unreadable board, or still active", async () => {
		const { table, sweeper } = createHarness(
			[
				// No board has the card (a deleted card, or another Kanban home's card under the shared legacy root).
				createProcessEntry({ pid: 101, cwd: `${ROOT}/zzzzz/foo`, cwdDeleted: true }),
				// The owning project's board can't be read.
				createProcessEntry({ pid: 102, cwd: `${ROOT}/abcde/bar`, cwdDeleted: true }),
				// Active card whose whole worktree is gone.
				createProcessEntry({ pid: 103, cwd: `${ROOT}/act01/foo`, cwdDeleted: true }),
				// A folder no registered project owns.
				createProcessEntry({ pid: 104, cwd: `${ROOT}/qqqqq/other`, cwdDeleted: true }),
			],
			{ workspaces: [FOO, { workspaceId: "bar", repoPath: "/projects/bar", board: null }] },
		);

		const result = await sweeper.sweep();

		expect(result.orphans.map((orphan) => [orphan.pid, orphan.reason, orphan.action, orphan.eligible])).toEqual([
			[101, "worktree_deleted", "reported", false],
			[102, "worktree_deleted", "reported", false],
			[103, "worktree_deleted", "reported", false],
			[104, "worktree_deleted", "reported", false],
		]);
		expect(table.signals).toEqual([]);
	});

	it("never signals the Cline hub daemon in a Done card's deleted worktree (pid 28163 on the pod), in either mode", async () => {
		const hub = createProcessEntry({
			pid: 28163,
			ppid: 1,
			command: `/usr/local/lib/node_modules/cline/bin/.cline --cline-hub-daemon --cwd ${ROOT}/don01/foo --port 25463`,
			cwd: `${ROOT}/don01/foo`,
			cwdDeleted: true,
			exe: "/usr/local/lib/node_modules/cline/bin/.cline",
		});
		for (const mode of ["terminate", "report"] as const) {
			const { table, sweeper } = createHarness([{ ...hub }], { settings: { mode } });

			const result = await sweeper.sweep();

			expect(result.orphans).toEqual([
				expect.objectContaining({
					pid: 28163,
					reason: "worktree_deleted",
					action: "shared_daemon",
					eligible: false,
					detail: "Cline hub daemon, used by every Cline card",
				}),
			]);
			expect(table.signals).toEqual([]);
		}
	});

	it("leaves a Done card's server that a live card's process is connected to", async () => {
		const { table, sweeper } = createHarness([
			createProcessEntry({ pid: 11, cwd: `${ROOT}/don01/foo`, command: "shared api" }),
			createProcessEntry({ pid: 12, cwd: `${ROOT}/act01/foo`, command: "client in a live card" }),
		]);
		connectLoopback(table, { serverPid: 11, clientPid: 12, port: 8080, clientPort: 41000, inode: 900 });

		const result = await sweeper.sweep();

		expect(result.orphans).toEqual([
			expect.objectContaining({
				pid: 11,
				action: "shared",
				eligible: false,
				detail: "connected from pid 12 outside the card: client in a live card",
			}),
		]);
		expect(table.signals).toEqual([]);
	});

	it("counts and reaps agent PTY sessions when the server is PID 2 (containers)", async () => {
		const { table, sweeper } = createHarness(
			[
				createProcessEntry({ pid: 1818353, ppid: 2, cwd: `${ROOT}/act01/foo`, command: "claude (live card)" }),
				createProcessEntry({ pid: 1057012, ppid: 2, cwd: `${ROOT}/don01/foo`, command: "claude (Done card)" }),
				createProcessEntry({
					pid: 66,
					ppid: 2,
					kernelThread: true,
					cwd: `${ROOT}/don01/foo`,
					command: "[kworker]",
				}),
			],
			{
				serverPid: 2,
				baseEntries: [
					createProcessEntry({ pid: 1, ppid: 0, command: "/run/podman-init -- kanban", cwd: "/" }),
					createProcessEntry({ pid: 2, ppid: 1, command: "node /usr/local/bin/kanban", cwd: "/projects" }),
				],
			},
		);

		const result = await sweeper.sweep();

		expect(result.processCount).toBe(2);
		expect(result.orphans).toEqual([expect.objectContaining({ pid: 1057012, action: "terminated" })]);
		expect(table.signals).toEqual([{ pid: 1057012, signal: "SIGTERM" }]);
	});

	it("only reports on a manual sweep while the periodic sweep is disabled", async () => {
		const { table, sweeper } = createHarness([createProcessEntry({ pid: 11, cwd: `${ROOT}/don01/foo` })], {
			settings: { enabled: false, mode: "terminate" },
		});

		const result = await sweeper.sweep();

		expect(result.mode).toBe("report");
		expect(result.orphans).toEqual([expect.objectContaining({ pid: 11, action: "reported", eligible: true })]);
		expect(table.signals).toEqual([]);
	});

	it("only reports processes of cards missing from their project's board, and ignores unknown projects", async () => {
		const { table, sweeper } = createHarness(
			[
				createProcessEntry({ pid: 30, cwd: `${ROOT}/mis01/foo`, command: "deleted card" }),
				createProcessEntry({ pid: 31, cwd: `${ROOT}/oth01/bar`, command: "another home's card" }),
			],
			{ existingPaths: [`${ROOT}/mis01/foo`, `${ROOT}/oth01/bar`] },
		);

		const result = await sweeper.sweep();

		expect(result.orphans).toEqual([
			expect.objectContaining({ pid: 30, taskId: "mis01", reason: "card_missing", action: "reported" }),
		]);
		expect(result.cards).toEqual(
			expect.arrayContaining([expect.objectContaining({ taskId: "oth01", status: "unknown", workspaceId: null })]),
		);
		expect(table.signals).toEqual([]);
	});

	it("treats every card of a project whose board could not be read as unknown", async () => {
		const { table, sweeper } = createHarness([createProcessEntry({ pid: 30, cwd: `${ROOT}/mis01/foo` })], {
			workspaces: [{ ...FOO, board: null }],
			existingPaths: [`${ROOT}/mis01/foo`],
		});

		const result = await sweeper.sweep();

		expect(result.orphans).toEqual([]);
		expect(result.cards[0]).toMatchObject({ taskId: "mis01", status: "unknown" });
		expect(table.signals).toEqual([]);
	});

	it("only reports orphans in report mode", async () => {
		const { table, sweeper } = createHarness([createProcessEntry({ pid: 11, cwd: `${ROOT}/don01/foo` })], {
			settings: { mode: "report" },
			existingPaths: [`${ROOT}/don01/foo`],
		});

		const result = await sweeper.sweep();

		expect(result.mode).toBe("report");
		expect(result.orphans).toEqual([expect.objectContaining({ pid: 11, action: "reported" })]);
		expect(table.signals).toEqual([]);
	});

	it("never signals the server or PID 1, even with their cwd in a Done card's worktree", async () => {
		const { table, sweeper } = createHarness([createProcessEntry({ pid: 11, cwd: `${ROOT}/don01/foo` })]);
		for (const pid of [1, SERVER_PID]) {
			const entry = table.processes.get(pid);
			if (entry) {
				entry.cwd = `${ROOT}/don01/foo`;
			}
		}

		const result = await sweeper.sweep();

		expect(result.orphans.map((orphan) => orphan.pid)).toEqual([11]);
		expect(table.signals.map((entry) => entry.pid)).toEqual([11]);
	});

	it("reports zombies of the server and of worktree processes with their parent, and never signals them", async () => {
		const { table, sweeper, log } = createHarness([
			createProcessEntry({ pid: 10, cwd: `${ROOT}/act01/foo`, command: "npm test" }),
			createProcessEntry({ pid: 40, ppid: 10, state: "Z", cwd: null, command: "[vitest]" }),
			createProcessEntry({ pid: 41, ppid: SERVER_PID, state: "Z", cwd: null, command: "[git]" }),
			createProcessEntry({ pid: 42, ppid: 1, state: "Z", cwd: null, command: "[unrelated]" }),
		]);

		const result = await sweeper.sweep();

		expect(result.zombies).toEqual([
			{ pid: 40, ppid: 10, command: "[vitest]", parentCommand: "npm test" },
			{ pid: 41, ppid: SERVER_PID, command: "[git]", parentCommand: "kanban" },
		]);
		expect(table.signals).toEqual([]);
		expect(log).toHaveBeenCalledWith("[process-reaper] zombie pid 40 (parent 10: npm test): [vitest]");
	});

	it("sweeps on the configured interval and skips sweeps while disabled", async () => {
		const { sweeper, loadSettings, settings, table } = createHarness([
			createProcessEntry({ pid: 11, cwd: `${ROOT}/don01/foo` }),
		]);
		settings.intervalSec = 120;
		settings.enabled = false;

		sweeper.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await sweeper.getStatus()).lastSweep).toBeNull();
		expect(loadSettings).toHaveBeenCalled();

		settings.enabled = true;
		await vi.advanceTimersByTimeAsync(120_000);
		const status = await sweeper.getStatus();
		expect(status.lastSweep?.orphans).toEqual([expect.objectContaining({ pid: 11, action: "terminated" })]);
		expect(table.processes.has(11)).toBe(false);

		sweeper.close();
		const calls = loadSettings.mock.calls.length;
		await vi.advanceTimersByTimeAsync(600_000);
		expect(loadSettings.mock.calls.length).toBe(calls);
	});

	it("logs one line and never schedules off Linux", async () => {
		const log = vi.fn();
		const loadSettings = vi.fn(async () => ({ enabled: true, intervalSec: 300, mode: "terminate" as const }));
		const sweeper = createOrphanProcessSweeper({
			reaper: createProcessReaper({ reader: null }),
			getWorktreeRoots: () => [ROOT],
			listWorkspaceBoards: async () => [],
			loadSettings,
			log,
		});

		sweeper.start();
		await vi.advanceTimersByTimeAsync(3_600_000);

		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toContain("needs /proc");
		expect(loadSettings).not.toHaveBeenCalled();
		expect((await sweeper.getStatus()).supported).toBe(false);
	});
});
