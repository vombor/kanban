import type { NetSocketTable, ProcessEntry, ProcessTableReader } from "../../src/server/process-table";

export function createProcessEntry(overrides: Partial<ProcessEntry> & { pid: number }): ProcessEntry {
	return {
		ppid: 1,
		state: "S",
		startTime: `${overrides.pid}00`,
		kernelThread: false,
		command: `proc-${overrides.pid}`,
		cwd: "/elsewhere",
		cwdDeleted: false,
		exe: "/usr/bin/node",
		exeDeleted: false,
		rssBytes: 10 * 1024 * 1024,
		...overrides,
	};
}

export interface FakeProcessTable {
	reader: ProcessTableReader;
	/** Records every signal and applies it: SIGKILL removes the process, SIGTERM too unless it ignores it. */
	signal: (pid: number, signal: NodeJS.Signals) => void;
	signals: Array<{ pid: number; signal: NodeJS.Signals }>;
	processes: Map<number, ProcessEntry>;
	ignoresSigterm: Set<number>;
	/** Socket inodes per pid (what /proc/<pid>/fd links to). */
	sockets: Map<number, string[]>;
	/** The network namespace's socket tables (shared by every process). */
	net: NetSocketTable;
}

/** `ADDR:PORT` in the kernel's hex form for 127.0.0.1. */
export function loopback(port: number): string {
	return `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Adds a listening socket on `port` owned by `serverPid` and one connection from `clientPid` to it. */
export function connectLoopback(
	table: FakeProcessTable,
	input: { serverPid: number; clientPid: number; port: number; clientPort: number; inode: number },
): void {
	const listen = String(input.inode);
	const accepted = String(input.inode + 1);
	const client = String(input.inode + 2);
	table.net.tcp.push(
		{ inode: listen, local: loopback(input.port), remote: "00000000:0000", state: "0A" },
		{ inode: accepted, local: loopback(input.port), remote: loopback(input.clientPort), state: "01" },
		{ inode: client, local: loopback(input.clientPort), remote: loopback(input.port), state: "01" },
	);
	table.sockets.set(input.serverPid, [...(table.sockets.get(input.serverPid) ?? []), listen, accepted]);
	table.sockets.set(input.clientPid, [...(table.sockets.get(input.clientPid) ?? []), client]);
}

export function createFakeProcessTable(entries: ProcessEntry[]): FakeProcessTable {
	const processes = new Map(entries.map((entry) => [entry.pid, entry]));
	const signals: FakeProcessTable["signals"] = [];
	const ignoresSigterm = new Set<number>();
	const sockets = new Map<number, string[]>();
	const net: NetSocketTable = { tcp: [], unix: [] };
	return {
		processes,
		signals,
		ignoresSigterm,
		sockets,
		net,
		reader: {
			list: async () => [...processes.values()].map((entry) => ({ ...entry })),
			read: async (pid) => {
				const entry = processes.get(pid);
				return entry ? { ...entry } : null;
			},
			readSocketInodes: async (pid) => (processes.has(pid) ? [...(sockets.get(pid) ?? [])] : []),
			readNetSockets: async () => ({ tcp: [...net.tcp], unix: [...net.unix] }),
		},
		signal: (pid, signal) => {
			signals.push({ pid, signal });
			if (!processes.has(pid)) {
				throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
			}
			if (signal === "SIGKILL" || (signal === "SIGTERM" && !ignoresSigterm.has(pid))) {
				processes.delete(pid);
			}
		},
	};
}
