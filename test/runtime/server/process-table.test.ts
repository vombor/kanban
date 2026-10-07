import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createProcProcessTableReader,
	isProcessTableSupported,
	parseNetTcp,
	parseNetUnix,
	parseProcStat,
	parseProcStatusRssBytes,
} from "../../../src/server/process-table";
import { createTempDir } from "../../utilities/temp-dir";

// Fields 3..22 of /proc/<pid>/stat after "(comm)": state, ppid, ... starttime (field 22).
// Fields 5..21; flags (field 9) is the fifth of them.
function statLine(pid: number, comm: string, state: string, ppid: number, startTime: string, flags = 4194560): string {
	const middle = Array.from({ length: 17 }, (_, index) => (index === 4 ? String(flags) : "0")).join(" ");
	return `${pid} (${comm}) ${state} ${ppid} ${middle} ${startTime} 1000 200\n`;
}

const PF_KTHREAD = 0x00200000;

interface FakeProc {
	pid: number;
	comm: string;
	state?: string;
	ppid?: number;
	startTime?: string;
	cmdline?: string[];
	cwd?: string;
	exe?: string;
	rssKb?: number;
	flags?: number;
	/** fd number -> link target, e.g. "socket:[123]". */
	fds?: Record<string, string>;
	net?: { tcp?: string; tcp6?: string; unix?: string };
}

describe("process table (/proc reader)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function createFakeProc(processes: FakeProc[]): string {
		const { path, cleanup } = createTempDir("kanban-fake-proc-");
		cleanups.push(cleanup);
		for (const proc of processes) {
			const dir = join(path, String(proc.pid));
			mkdirSync(dir);
			writeFileSync(
				join(dir, "stat"),
				statLine(proc.pid, proc.comm, proc.state ?? "S", proc.ppid ?? 1, proc.startTime ?? "4242", proc.flags),
			);
			if (proc.fds) {
				mkdirSync(join(dir, "fd"));
				for (const [fd, target] of Object.entries(proc.fds)) {
					symlinkSync(target, join(dir, "fd", fd));
				}
			}
			if (proc.net) {
				mkdirSync(join(dir, "net"));
				for (const [name, content] of Object.entries(proc.net)) {
					writeFileSync(join(dir, "net", name), content);
				}
			}
			writeFileSync(join(dir, "cmdline"), proc.cmdline ? `${proc.cmdline.join("\0")}\0` : "");
			if (proc.rssKb !== undefined) {
				writeFileSync(join(dir, "status"), `Name:\t${proc.comm}\nVmRSS:\t   ${proc.rssKb} kB\nThreads:\t1\n`);
			}
			// readlink returns the target text verbatim, so " (deleted)" can be faked as part of it.
			if (proc.cwd) {
				symlinkSync(proc.cwd, join(dir, "cwd"));
			}
			if (proc.exe) {
				symlinkSync(proc.exe, join(dir, "exe"));
			}
		}
		mkdirSync(join(path, "self"));
		writeFileSync(join(path, "uptime"), "1.0 1.0\n");
		return path;
	}

	it("is supported on Linux only", () => {
		expect(isProcessTableSupported("linux")).toBe(true);
		expect(isProcessTableSupported("darwin")).toBe(false);
		expect(isProcessTableSupported("win32")).toBe(false);
	});

	it("parses stat lines whose comm contains spaces and parentheses", () => {
		expect(parseProcStat(statLine(7, "tsx (watch) x", "R", 3, "999"))).toEqual({
			comm: "tsx (watch) x",
			state: "R",
			ppid: 3,
			flags: 4194560,
			startTime: "999",
		});
		expect(parseProcStat("garbage")).toBeNull();
		expect(parseProcStatusRssBytes("VmRSS:\t  2048 kB\n")).toBe(2048 * 1024);
		expect(parseProcStatusRssBytes("Name:\tzombie\n")).toBe(0);
	});

	it("reads cwd, exe, command and RSS, and strips the (deleted) suffix", async () => {
		const procRoot = createFakeProc([
			{
				pid: 100,
				comm: "node",
				ppid: 1,
				startTime: "5000",
				cmdline: ["node", "ts-node-dev", "src/server.ts"],
				cwd: "/wt/abc12/foo",
				exe: "/usr/bin/node",
				rssKb: 1024,
			},
			{ pid: 101, comm: "tail", cmdline: ["tail", "-f", "dev.log"], cwd: "/wt/def34/foo (deleted)", rssKb: 512 },
			{ pid: 102, comm: "sleep", state: "Z", ppid: 100 },
		]);
		const reader = createProcProcessTableReader(procRoot);

		const entries = await reader.list();

		expect(entries.map((entry) => entry.pid).sort()).toEqual([100, 101, 102]);
		expect(entries.find((entry) => entry.pid === 100)).toEqual({
			pid: 100,
			ppid: 1,
			state: "S",
			startTime: "5000",
			kernelThread: false,
			command: "node ts-node-dev src/server.ts",
			cwd: "/wt/abc12/foo",
			cwdDeleted: false,
			exe: "/usr/bin/node",
			exeDeleted: false,
			rssBytes: 1024 * 1024,
		});
		expect(entries.find((entry) => entry.pid === 101)).toMatchObject({
			cwd: "/wt/def34/foo",
			cwdDeleted: true,
			command: "tail -f dev.log",
		});
		// A zombie has no cmdline, cwd or RSS.
		expect(entries.find((entry) => entry.pid === 102)).toMatchObject({
			state: "Z",
			ppid: 100,
			command: "[sleep]",
			cwd: null,
			rssBytes: 0,
		});
		expect(await reader.read(999)).toBeNull();
	});

	it("detects kernel threads from PF_KTHREAD, not from the parent pid", async () => {
		const procRoot = createFakeProc([
			// In a container PID 2 is often the Kanban server; its PTY children are ordinary processes.
			{ pid: 2, comm: "node", ppid: 1, cmdline: ["node", "kanban"], cwd: "/projects", exe: "/usr/bin/node" },
			{ pid: 30, comm: "claude", ppid: 2, cmdline: ["claude"], cwd: "/wt/abc12/foo", exe: "/usr/bin/claude" },
			{ pid: 31, comm: "kworker/0:1", ppid: 2, flags: 0x00208040 },
			// No flag (old kernel) but no command line and no executable: still a kernel thread.
			{ pid: 32, comm: "ksoftirqd/0", ppid: 2, flags: 0 },
		]);
		const entries = await createProcProcessTableReader(procRoot).list();
		const byPid = new Map(entries.map((entry) => [entry.pid, entry.kernelThread]));

		expect(Object.fromEntries(byPid)).toEqual({ 2: false, 30: false, 31: true, 32: true });
		expect(PF_KTHREAD & 0x00208040).not.toBe(0);
	});

	it("reads socket inodes from fd links and the tcp/unix tables of the process's namespace", async () => {
		const tcp = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 0100007F:6357 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9001 1 0000 100 0 0 10 0",
			"   1: 0100007F:6357 0100007F:A000 01 00000000:00000000 00:00000000 00000000     0        0 9002 1 0000 20 4 30 10 -1",
			"   2: 0100007F:A000 0100007F:6357 01 00000000:00000000 00:00000000 00000000     0        0 9003 1 0000 20 4 30 10 -1",
			"   3: 0100007F:B000 0100007F:6357 06 00000000:00000000 03:00000000 00000000     0        0 0 3 0000",
		].join("\n");
		const unix = [
			"Num       RefCount Protocol Flags    Type St Inode Path",
			"0000000000000000: 00000002 00000000 00010000 0001 01 7001 /tmp/hub.sock",
			"0000000000000000: 00000003 00000000 00000000 0001 03 7002 /tmp/hub.sock",
			"0000000000000000: 00000003 00000000 00000000 0001 03 7003",
		].join("\n");
		const procRoot = createFakeProc([
			{
				pid: 28163,
				comm: ".cline",
				cmdline: [".cline", "--cline-hub-daemon"],
				cwd: "/wt/6dfa2/foo (deleted)",
				exe: "/usr/bin/cline",
				fds: {
					0: "/dev/null",
					3: "socket:[9001]",
					4: "socket:[9002]",
					5: "anon_inode:[eventpoll]",
					6: "socket:[7001]",
				},
				net: { tcp, unix, tcp6: "  sl  local_address remote_address st\n" },
			},
		]);
		const reader = createProcProcessTableReader(procRoot);

		expect(await reader.readSocketInodes(28163)).toEqual(["9001", "9002", "7001"]);
		expect(await reader.readSocketInodes(999)).toEqual([]);
		const net = await reader.readNetSockets(28163);
		expect(net.tcp).toEqual([
			{ inode: "9001", local: "0100007F:6357", remote: "00000000:0000", state: "0A" },
			{ inode: "9002", local: "0100007F:6357", remote: "0100007F:A000", state: "01" },
			{ inode: "9003", local: "0100007F:A000", remote: "0100007F:6357", state: "01" },
		]);
		expect(net.unix).toEqual([
			{ inode: "7001", path: "/tmp/hub.sock", listening: true, connected: false },
			{ inode: "7002", path: "/tmp/hub.sock", listening: false, connected: true },
			{ inode: "7003", path: "", listening: false, connected: true },
		]);
		expect(parseNetTcp("header only\n")).toEqual([]);
		expect(parseNetUnix("")).toEqual([]);
	});

	it("returns an empty table when the proc root is missing", async () => {
		expect(await createProcProcessTableReader("/nonexistent-kanban-proc").list()).toEqual([]);
	});
});
