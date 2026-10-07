import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProcessReaper } from "../../../src/server/process-reaper";
import { connectLoopback, createFakeProcessTable, createProcessEntry } from "../../utilities/fake-process-table";

const SERVER_PID = 500;
const ROOT = "/kanban-test-worktrees";
const WORKTREE = `${ROOT}/abc12/foo`;

function createHarness(entries: Parameters<typeof createFakeProcessTable>[0]) {
	const table = createFakeProcessTable([
		createProcessEntry({ pid: 1, ppid: 0, command: "init", cwd: "/" }),
		createProcessEntry({ pid: 2, ppid: 0, command: "[kthreadd]", cwd: "/" }),
		createProcessEntry({ pid: 400, ppid: 1, command: "bash", cwd: "/home/dev" }),
		createProcessEntry({ pid: SERVER_PID, ppid: 400, command: "kanban", cwd: "/home/dev" }),
		...entries,
	]);
	const log = vi.fn();
	const reaper = createProcessReaper({
		reader: table.reader,
		signal: table.signal,
		serverPid: SERVER_PID,
		graceMs: 5_000,
		pollMs: 100,
		getWorktreeRoots: () => [ROOT],
		log,
	});
	const reapWorktree = async (sessionPids: number[] = []) => {
		const prepared = await reaper.prepareWorktreeReap({ taskId: "abc12", worktreePaths: [WORKTREE], sessionPids });
		return await prepared.reap();
	};
	return { table, reaper, log, reapWorktree };
}

describe("process reaper", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("terminates processes whose cwd or executable is inside the worktree and leaves the rest", async () => {
		const { table, reapWorktree, log } = createHarness([
			createProcessEntry({ pid: 10, cwd: WORKTREE, command: "npm run dev:servers" }),
			createProcessEntry({ pid: 11, cwd: `${WORKTREE}/web-ui`, command: "tsx preview" }),
			createProcessEntry({ pid: 12, cwd: "/tmp", exe: `${WORKTREE}/bin/tool`, command: "tool" }),
			// Same task folder prefix but another directory: outside.
			createProcessEntry({ pid: 13, cwd: `${WORKTREE}-other`, command: "other" }),
			createProcessEntry({ pid: 14, cwd: "/kanban-test-worktrees/zzz99/foo", command: "another card" }),
		]);

		const outcomes = await reapWorktree();

		expect(outcomes.map((outcome) => [outcome.entry.pid, outcome.action]).sort()).toEqual([
			[10, "terminated"],
			[11, "terminated"],
			[12, "terminated"],
		]);
		expect(table.signals).toEqual([
			{ pid: 10, signal: "SIGTERM" },
			{ pid: 11, signal: "SIGTERM" },
			{ pid: 12, signal: "SIGTERM" },
		]);
		expect([...table.processes.keys()]).toEqual(expect.arrayContaining([13, 14]));
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("terminated pid 10 of card abc12 (10.0 MB): npm run dev:servers"),
		);
	});

	it("does nothing (and waits for nothing) when no process is in the worktree", async () => {
		const { table, reapWorktree } = createHarness([createProcessEntry({ pid: 10, cwd: "/tmp" })]);

		expect(await reapWorktree()).toEqual([]);
		expect(table.signals).toEqual([]);
	});

	it("never signals PID 1/2, kernel threads, the server or its ancestors, even inside the worktree", async () => {
		const { table, reaper } = createHarness([
			createProcessEntry({ pid: 3, ppid: 2, kernelThread: true, command: "[kworker]", cwd: WORKTREE }),
			createProcessEntry({ pid: 10, cwd: WORKTREE }),
		]);
		for (const pid of [1, 2, 400, SERVER_PID]) {
			const entry = table.processes.get(pid);
			if (entry) {
				entry.cwd = WORKTREE;
			}
		}

		const prepared = await reaper.prepareWorktreeReap({
			taskId: "abc12",
			worktreePaths: [WORKTREE],
			// Even a session tree that (wrongly) names the server is not followed into protected pids.
			sessionPids: [SERVER_PID],
		});
		const outcomes = await prepared.reap();

		expect(outcomes.map((outcome) => outcome.entry.pid)).toEqual([10]);
		expect(table.signals.map((entry) => entry.pid)).toEqual([10]);
	});

	it("escalates to SIGKILL for processes that survive the SIGTERM grace period", async () => {
		const { table, reapWorktree } = createHarness([
			createProcessEntry({ pid: 10, cwd: WORKTREE, command: "polite" }),
			createProcessEntry({ pid: 11, cwd: WORKTREE, command: "stubborn" }),
		]);
		table.ignoresSigterm.add(11);

		const done = reapWorktree();
		await vi.advanceTimersByTimeAsync(4_900);
		expect(table.signals).toEqual([
			{ pid: 10, signal: "SIGTERM" },
			{ pid: 11, signal: "SIGTERM" },
		]);
		await vi.advanceTimersByTimeAsync(2_000);
		const outcomes = await done;

		expect(table.signals).toEqual([
			{ pid: 10, signal: "SIGTERM" },
			{ pid: 11, signal: "SIGTERM" },
			{ pid: 11, signal: "SIGKILL" },
		]);
		expect(Object.fromEntries(outcomes.map((outcome) => [outcome.entry.pid, outcome.action]))).toEqual({
			10: "terminated",
			11: "killed",
		});
	});

	it("reaps the session tree captured before the session stopped, wherever its cwd is", async () => {
		const { table, reaper } = createHarness([
			createProcessEntry({ pid: 20, ppid: SERVER_PID, cwd: WORKTREE, command: "claude" }),
			createProcessEntry({ pid: 21, ppid: 20, cwd: "/projects/other", command: "npm test" }),
			createProcessEntry({ pid: 22, ppid: 21, cwd: "/projects/other", command: "vitest" }),
			createProcessEntry({ pid: 30, ppid: 1, cwd: "/projects/other", command: "unrelated" }),
		]);

		const prepared = await reaper.prepareWorktreeReap({
			taskId: "abc12",
			worktreePaths: [WORKTREE],
			sessionPids: [20],
		});
		// Stopping the session kills its PTY child; the grandchildren reparent to init.
		table.processes.delete(20);
		for (const pid of [21, 22]) {
			const entry = table.processes.get(pid);
			if (entry) {
				entry.ppid = 1;
			}
		}
		const outcomes = await prepared.reap();

		expect(outcomes.map((outcome) => outcome.entry.pid).sort()).toEqual([21, 22]);
		expect(table.processes.has(30)).toBe(true);
	});

	it("leaves a pid alone when it was reused by another process since the scan", async () => {
		const { table, reaper } = createHarness([
			createProcessEntry({ pid: 21, ppid: 20, cwd: "/tmp", command: "child", startTime: "111" }),
			createProcessEntry({ pid: 20, ppid: SERVER_PID, cwd: "/tmp", command: "claude" }),
		]);

		const prepared = await reaper.prepareWorktreeReap({
			taskId: "abc12",
			worktreePaths: [WORKTREE],
			sessionPids: [20],
		});
		table.processes.delete(20);
		table.processes.set(21, createProcessEntry({ pid: 21, cwd: "/tmp", command: "new owner", startTime: "999" }));
		const outcomes = await prepared.reap();

		expect(outcomes).toEqual([]);
		expect(table.signals).toEqual([]);
	});

	it("does not signal zombies and treats a process that became a zombie as exited", async () => {
		const { table } = createHarness([
			createProcessEntry({ pid: 10, cwd: WORKTREE, state: "Z" }),
			createProcessEntry({ pid: 11, cwd: WORKTREE }),
		]);
		table.ignoresSigterm.add(11);
		const originalSignal = table.signal;
		const reaper = createProcessReaper({
			reader: table.reader,
			serverPid: SERVER_PID,
			pollMs: 100,
			signal: (pid, signal) => {
				originalSignal(pid, signal);
				const entry = table.processes.get(pid);
				if (entry && signal === "SIGTERM") {
					entry.state = "Z";
				}
			},
		});

		const prepared = await reaper.prepareWorktreeReap({
			taskId: "abc12",
			worktreePaths: [WORKTREE],
			sessionPids: [],
		});
		const done = prepared.reap();
		await vi.advanceTimersByTimeAsync(200);
		const outcomes = await done;

		expect(table.signals).toEqual([{ pid: 11, signal: "SIGTERM" }]);
		expect(outcomes.map((outcome) => [outcome.entry.pid, outcome.action])).toEqual([[11, "terminated"]]);
	});

	it("reports a failed signal (EPERM) without throwing", async () => {
		const { table, reaper } = createHarness([createProcessEntry({ pid: 10, cwd: WORKTREE })]);
		const failing = createProcessReaper({
			reader: table.reader,
			serverPid: SERVER_PID,
			signal: () => {
				throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
			},
		});

		const prepared = await failing.prepareWorktreeReap({
			taskId: "abc12",
			worktreePaths: [WORKTREE],
			sessionPids: [],
		});
		const outcomes = await prepared.reap();

		expect(outcomes).toEqual([expect.objectContaining({ action: "failed", error: "kill EPERM" })]);
		expect(reaper.supported).toBe(true);
	});

	it("never signals the Cline hub daemon running in the Done card's worktree (pid 28163 on the pod)", async () => {
		// The pod: the hub was started by card 6dfa2, whose worktree is gone; live Cline cards still use it.
		const hubWorktree = `${ROOT}/6dfa2/foo`;
		const { table, reaper, log } = createHarness([
			createProcessEntry({
				pid: 28163,
				ppid: 1,
				command: `/usr/local/lib/node_modules/cline/bin/.cline --cline-hub-daemon --cwd ${hubWorktree} --port 25463`,
				cwd: hubWorktree,
				cwdDeleted: true,
				exe: "/usr/local/lib/node_modules/cline/bin/.cline",
			}),
			createProcessEntry({ pid: 10, cwd: hubWorktree, command: "npm run dev" }),
		]);

		const prepared = await reaper.prepareWorktreeReap({
			taskId: "6dfa2",
			worktreePaths: [hubWorktree],
			sessionPids: [],
		});
		const outcomes = await prepared.reap();

		expect(table.signals).toEqual([{ pid: 10, signal: "SIGTERM" }]);
		expect(outcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entry: expect.objectContaining({ pid: 28163 }), action: "shared_daemon" }),
				expect.objectContaining({ entry: expect.objectContaining({ pid: 10 }), action: "terminated" }),
			]),
		);
		expect(table.processes.has(28163)).toBe(true);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("shared_daemon pid 28163 of card 6dfa2"));
	});

	it("leaves a server running when a process outside the card is connected to it, and reports who", async () => {
		const { table, reapWorktree } = createHarness([
			createProcessEntry({ pid: 10, cwd: WORKTREE, command: "vite dev" }),
			createProcessEntry({ pid: 30, cwd: "/kanban-test-worktrees/zzz99/foo", command: "cline (other card)" }),
		]);
		connectLoopback(table, { serverPid: 10, clientPid: 30, port: 5173, clientPort: 40001, inode: 100 });

		const outcomes = await reapWorktree();

		expect(table.signals).toEqual([]);
		expect(outcomes).toEqual([
			expect.objectContaining({
				action: "shared",
				detail: "connected from pid 30 outside the card: cline (other card)",
			}),
		]);
	});

	it("still terminates a server whose only clients belong to the same card, and a client of an outside server", async () => {
		const { table, reapWorktree } = createHarness([
			createProcessEntry({ pid: 10, cwd: WORKTREE, command: "api server" }),
			createProcessEntry({ pid: 11, cwd: `${WORKTREE}/web`, command: "test runner" }),
			createProcessEntry({ pid: 12, cwd: WORKTREE, command: "claude" }),
			createProcessEntry({ pid: 40, cwd: "/projects", command: "kanban hooks endpoint" }),
		]);
		connectLoopback(table, { serverPid: 10, clientPid: 11, port: 3000, clientPort: 40002, inode: 200 });
		// 12 is the client here: an outgoing connection does not make it shared.
		connectLoopback(table, { serverPid: 40, clientPid: 12, port: 3484, clientPort: 40003, inode: 300 });

		const outcomes = await reapWorktree();

		expect(outcomes.map((outcome) => [outcome.entry.pid, outcome.action]).sort()).toEqual([
			[10, "terminated"],
			[11, "terminated"],
			[12, "terminated"],
		]);
		expect(table.processes.has(40)).toBe(true);
	});

	it("leaves a process that accepted connections on a named unix socket", async () => {
		const { table, reapWorktree } = createHarness([
			createProcessEntry({ pid: 10, cwd: WORKTREE, command: "daemon" }),
		]);
		table.sockets.set(10, ["500", "501"]);
		table.net.unix.push(
			{ inode: "500", path: "/tmp/daemon.sock", listening: true, connected: false },
			{ inode: "501", path: "/tmp/daemon.sock", listening: false, connected: true },
		);

		const outcomes = await reapWorktree();

		expect(table.signals).toEqual([]);
		expect(outcomes).toEqual([
			expect.objectContaining({ action: "shared", detail: "accepts connections on unix socket /tmp/daemon.sock" }),
		]);
	});

	it("leaves a process whose child works in another card's worktree", async () => {
		const { table, reapWorktree } = createHarness([
			createProcessEntry({ pid: 10, cwd: WORKTREE, command: "agent host" }),
			createProcessEntry({ pid: 31, ppid: 10, cwd: `${ROOT}/zzz99/foo`, command: "worker for zzz99" }),
			createProcessEntry({ pid: 32, ppid: 10, cwd: "/tmp", command: "temp worker" }),
		]);

		const outcomes = await reapWorktree();

		expect(table.signals).toEqual([]);
		expect(outcomes).toEqual([
			expect.objectContaining({
				entry: expect.objectContaining({ pid: 10 }),
				action: "shared",
				detail: `child pid 31 works in another worktree (${ROOT}/zzz99/foo)`,
			}),
		]);
	});

	it("reaps PTY session roots when the server is PID 2 (containers); only PF_KTHREAD marks kernel threads", async () => {
		const table = createFakeProcessTable([
			createProcessEntry({ pid: 1, ppid: 0, command: "/run/podman-init -- kanban", cwd: "/" }),
			createProcessEntry({ pid: 2, ppid: 1, command: "node /usr/local/bin/kanban --port 3485", cwd: "/projects" }),
			createProcessEntry({ pid: 1818353, ppid: 2, command: "claude --permission-mode auto", cwd: WORKTREE }),
			createProcessEntry({ pid: 305116, ppid: 2, command: "bash -i", cwd: "/projects/foo" }),
			createProcessEntry({ pid: 77, ppid: 2, kernelThread: true, command: "[kworker/0:1]", cwd: WORKTREE }),
		]);
		const reaper = createProcessReaper({ reader: table.reader, signal: table.signal, serverPid: 2, pollMs: 100 });

		const snapshot = await reaper.snapshot();
		expect([...snapshot.protectedPids].sort((a, b) => a - b)).toEqual([0, 1, 2, 77]);
		const prepared = await reaper.prepareWorktreeReap({
			taskId: "abc12",
			worktreePaths: [WORKTREE],
			sessionPids: [],
		});
		const outcomes = await prepared.reap();

		expect(outcomes.map((outcome) => [outcome.entry.pid, outcome.action])).toEqual([[1818353, "terminated"]]);
		expect(table.signals).toEqual([{ pid: 1818353, signal: "SIGTERM" }]);
	});

	it("is a no-op without a process table (not Linux)", async () => {
		const reaper = createProcessReaper({ reader: null });

		const prepared = await reaper.prepareWorktreeReap({
			taskId: "abc12",
			worktreePaths: [WORKTREE],
			sessionPids: [1],
		});

		expect(reaper.supported).toBe(false);
		expect(await prepared.reap()).toEqual([]);
		expect((await reaper.snapshot()).entries).toEqual([]);
	});
});
