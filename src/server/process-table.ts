// Reads the machine's process table for the process reaper (src/server/process-reaper.ts).
// Linux only: everything comes from /proc. Other platforms get no reader, and the reaper is a no-op there.
// The reader is injected so tests can point it at a fake /proc directory or replace it outright.
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

/** What the kernel appends to a /proc/<pid>/cwd or exe link whose target was removed. */
const DELETED_LINK_SUFFIX = " (deleted)";
const PROC_ROOT = "/proc";
const COMMAND_MAX_LENGTH = 300;
/** PF_KTHREAD in the flags field of /proc/<pid>/stat. */
const PF_KTHREAD = 0x00200000;
const SOCKET_LINK_PATTERN = /^socket:\[(\d+)\]$/u;
/** __SO_ACCEPTCON in the Flags column of /proc/net/unix: a listening socket. */
const UNIX_ACCEPTCON_FLAG = 0x00010000;
const UNIX_STATE_CONNECTED = "03";
const TCP_STATE_ESTABLISHED = "01";
const TCP_STATE_LISTEN = "0A";

export interface ProcessEntry {
	pid: number;
	ppid: number;
	/** One-letter state from /proc/<pid>/stat (`R`, `S`, `Z`, ...). */
	state: string;
	/** Start time in clock ticks since boot. With the pid it identifies a process across reads (pid reuse). */
	startTime: string;
	/**
	 * From PF_KTHREAD. Not from the parent pid: in a container PID 2 can be an ordinary process (here it is
	 * often the Kanban server itself), so "child of PID 2" says nothing.
	 */
	kernelThread: boolean;
	/** The command line, or `[comm]` when it is empty (zombies, kernel threads). */
	command: string;
	/** Working directory, without the ` (deleted)` suffix. Null when it can't be read (other users, zombies). */
	cwd: string | null;
	cwdDeleted: boolean;
	exe: string | null;
	exeDeleted: boolean;
	rssBytes: number;
}

/** One row of /proc/net/tcp or tcp6. Addresses are kept as the kernel's hex `ADDR:PORT` strings. */
export interface TcpSocketRow {
	inode: string;
	local: string;
	remote: string;
	/** Hex state: `0A` listen, `01` established. */
	state: string;
}

/** One row of /proc/net/unix. `path` is empty for unnamed sockets (socketpairs, the client end of a connection). */
export interface UnixSocketRow {
	inode: string;
	path: string;
	listening: boolean;
	connected: boolean;
}

export interface NetSocketTable {
	tcp: TcpSocketRow[];
	unix: UnixSocketRow[];
}

export interface ProcessTableReader {
	list: () => Promise<ProcessEntry[]>;
	/** Re-reads one process; null when it no longer exists. */
	read: (pid: number) => Promise<ProcessEntry | null>;
	/** Inodes of the sockets the process has open (from its fd links). Empty when they can't be read. */
	readSocketInodes: (pid: number) => Promise<string[]>;
	/** The TCP and unix socket tables as seen from the process's network namespace. */
	readNetSockets: (pid: number) => Promise<NetSocketTable>;
}

export function isProcessTableSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "linux";
}

interface ParsedProcStat {
	comm: string;
	state: string;
	ppid: number;
	flags: number;
	startTime: string;
}

/** Parses /proc/<pid>/stat. `comm` may contain spaces and parentheses, so fields are split after the last `)`. */
export function parseProcStat(content: string): ParsedProcStat | null {
	const open = content.indexOf("(");
	const close = content.lastIndexOf(")");
	if (open < 0 || close < open) {
		return null;
	}
	// Fields after comm, starting with field 3 (state). flags is field 9, starttime field 22.
	const fields = content
		.slice(close + 1)
		.trim()
		.split(/\s+/u);
	const state = fields[0];
	const ppid = Number(fields[1]);
	const flags = Number(fields[6]);
	const startTime = fields[19];
	if (!state || !Number.isInteger(ppid) || !Number.isFinite(flags) || !startTime) {
		return null;
	}
	return { comm: content.slice(open + 1, close), state, ppid, flags, startTime };
}

/** VmRSS from /proc/<pid>/status, in bytes. Zombies and kernel threads have none. */
export function parseProcStatusRssBytes(content: string): number {
	const match = /^VmRSS:\s+(\d+)\s+kB/mu.exec(content);
	return match ? Number(match[1]) * 1024 : 0;
}

export function parseNetTcp(content: string): TcpSocketRow[] {
	const rows: TcpSocketRow[] = [];
	for (const line of content.split("\n").slice(1)) {
		// sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ...
		const fields = line.trim().split(/\s+/u);
		const [, local, remote, state] = fields;
		const inode = fields[9];
		if (local && remote && state && inode && inode !== "0") {
			rows.push({ inode, local, remote, state: state.toUpperCase() });
		}
	}
	return rows;
}

export function parseNetUnix(content: string): UnixSocketRow[] {
	const rows: UnixSocketRow[] = [];
	for (const line of content.split("\n").slice(1)) {
		// Num RefCount Protocol Flags Type St Inode [Path]
		const fields = line.trim().split(/\s+/u);
		const flags = Number.parseInt(fields[3] ?? "", 16);
		const state = fields[5];
		const inode = fields[6];
		if (!inode || !state || Number.isNaN(flags)) {
			continue;
		}
		rows.push({
			inode,
			path: fields.slice(7).join(" "),
			listening: (flags & UNIX_ACCEPTCON_FLAG) !== 0,
			connected: state === UNIX_STATE_CONNECTED,
		});
	}
	return rows;
}

export function isTcpListening(row: TcpSocketRow): boolean {
	return row.state === TCP_STATE_LISTEN;
}

export function isTcpEstablished(row: TcpSocketRow): boolean {
	return row.state === TCP_STATE_ESTABLISHED;
}

/** The port part of a kernel `ADDR:PORT` hex address. */
export function getTcpPort(address: string): string {
	return address.slice(address.lastIndexOf(":") + 1);
}

function parseLinkTarget(target: string | null): { path: string | null; deleted: boolean } {
	if (target === null) {
		return { path: null, deleted: false };
	}
	if (target.endsWith(DELETED_LINK_SUFFIX)) {
		return { path: target.slice(0, -DELETED_LINK_SUFFIX.length), deleted: true };
	}
	return { path: target, deleted: false };
}

function formatCommand(cmdline: string | null, comm: string): string {
	const command = (cmdline ?? "").split("\0").filter(Boolean).join(" ").trim();
	const text = command || `[${comm}]`;
	return text.length > COMMAND_MAX_LENGTH ? `${text.slice(0, COMMAND_MAX_LENGTH - 1)}…` : text;
}

async function readOptionalFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function readOptionalLink(path: string): Promise<string | null> {
	try {
		return await readlink(path);
	} catch {
		return null;
	}
}

export function createProcProcessTableReader(procRoot: string = PROC_ROOT): ProcessTableReader {
	const read = async (pid: number): Promise<ProcessEntry | null> => {
		const dir = join(procRoot, String(pid));
		const statContent = await readOptionalFile(join(dir, "stat"));
		const stat = statContent ? parseProcStat(statContent) : null;
		if (!stat) {
			return null;
		}
		const [cmdline, status, cwdTarget, exeTarget] = await Promise.all([
			readOptionalFile(join(dir, "cmdline")),
			readOptionalFile(join(dir, "status")),
			readOptionalLink(join(dir, "cwd")),
			readOptionalLink(join(dir, "exe")),
		]);
		const cwd = parseLinkTarget(cwdTarget);
		const exe = parseLinkTarget(exeTarget);
		// Fallback for kernels without the flag: kernel threads have no command line and no executable.
		const kernelThread = (stat.flags & PF_KTHREAD) !== 0 || (!cmdline && exeTarget === null && stat.state !== "Z");
		return {
			pid,
			ppid: stat.ppid,
			state: stat.state,
			startTime: stat.startTime,
			kernelThread,
			command: formatCommand(cmdline, stat.comm),
			cwd: cwd.path,
			cwdDeleted: cwd.deleted,
			exe: exe.path,
			exeDeleted: exe.deleted,
			rssBytes: status ? parseProcStatusRssBytes(status) : 0,
		};
	};

	return {
		read,
		list: async () => {
			let names: string[];
			try {
				names = await readdir(procRoot);
			} catch {
				return [];
			}
			const pids = names.filter((name) => /^\d+$/u.test(name)).map(Number);
			const entries = await Promise.all(pids.map(read));
			return entries.filter((entry): entry is ProcessEntry => entry !== null);
		},
		readSocketInodes: async (pid) => {
			const fdDir = join(procRoot, String(pid), "fd");
			let fds: string[];
			try {
				fds = await readdir(fdDir);
			} catch {
				return [];
			}
			const links = await Promise.all(fds.map((fd) => readOptionalLink(join(fdDir, fd))));
			return links.flatMap((link) => {
				const match = link ? SOCKET_LINK_PATTERN.exec(link) : null;
				return match?.[1] ? [match[1]] : [];
			});
		},
		readNetSockets: async (pid) => {
			const netDir = join(procRoot, String(pid), "net");
			const [tcp, tcp6, unix] = await Promise.all([
				readOptionalFile(join(netDir, "tcp")),
				readOptionalFile(join(netDir, "tcp6")),
				readOptionalFile(join(netDir, "unix")),
			]);
			return {
				tcp: [...parseNetTcp(tcp ?? ""), ...parseNetTcp(tcp6 ?? "")],
				unix: parseNetUnix(unix ?? ""),
			};
		},
	};
}
