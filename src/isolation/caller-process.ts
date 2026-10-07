// Traces a runtime request without a session credential back to the process that made it, and from there to an agent
// session's process tree (Linux only, through the process reaper's /proc reader, src/server/process-table.ts). A
// loopback TCP connection's client end is a socket the calling process holds: its inode is found in the server's
// network namespace by the two ports, the process by its fd links, and the session by walking the parent chain up to
// a session's PTY child. A process that left the tree (a daemon reparented to init) is not found: like the rest of
// isolation this is a guard against an agent's ordinary command forms, not a sandbox (same uid as the server).
import type { ProcessEntry, ProcessTableReader } from "../server/process-table";
import { getTcpPort, isTcpEstablished } from "../server/process-table";

export interface PeerConnection {
	remoteAddress: string | undefined;
	remotePort: number | undefined;
	localPort: number | undefined;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_PARENT_DEPTH = 64;

function toKernelPort(port: number): string {
	return port.toString(16).toUpperCase().padStart(4, "0");
}

export function isLoopbackConnection(connection: PeerConnection): boolean {
	return Boolean(connection.remoteAddress && LOOPBACK_ADDRESSES.has(connection.remoteAddress));
}

/** The pid of the local process holding the client end of the connection, or null. */
export async function findPeerProcessPid(
	reader: ProcessTableReader,
	connection: PeerConnection,
	serverPid: number = process.pid,
): Promise<{ pid: number; processes: ProcessEntry[] } | null> {
	if (!isLoopbackConnection(connection) || !connection.remotePort || !connection.localPort) {
		return null;
	}
	const clientPort = toKernelPort(connection.remotePort);
	const serverPort = toKernelPort(connection.localPort);
	const { tcp } = await reader.readNetSockets(serverPid);
	// The client's row: its local port is the request's remote port.
	const inodes = new Set(
		tcp
			.filter(
				(row) =>
					isTcpEstablished(row) && getTcpPort(row.local) === clientPort && getTcpPort(row.remote) === serverPort,
			)
			.map((row) => row.inode)
			.filter((inode) => inode !== "0"),
	);
	if (inodes.size === 0) {
		return null;
	}
	const processes = await reader.list();
	for (const entry of processes) {
		if (entry.pid === serverPid || entry.kernelThread) {
			continue;
		}
		const sockets = await reader.readSocketInodes(entry.pid);
		if (sockets.some((inode) => inodes.has(inode))) {
			return { pid: entry.pid, processes };
		}
	}
	return null;
}

/**
 * `pid` and its parents, nearest first, up to (not including) PID 1. A process reparented to init (`setsid -f`, a
 * daemon) has a short chain: it reaches no session, which is why credential-less callers are never trusted for
 * grants (approvals.ts).
 */
export function listParentChain(pid: number, processes: readonly ProcessEntry[]): number[] {
	const parents = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
	const chain: number[] = [];
	let current: number | undefined = pid;
	for (let depth = 0; current !== undefined && current > 1 && depth < MAX_PARENT_DEPTH; depth += 1) {
		chain.push(current);
		current = parents.get(current);
	}
	return chain;
}

/** The first of `sessionPids` on the parent chain of `pid` (itself included), or null. */
export function findSessionAncestor(
	pid: number,
	processes: readonly ProcessEntry[],
	sessionPids: ReadonlySet<number>,
): number | null {
	return listParentChain(pid, processes).find((candidate) => sessionPids.has(candidate)) ?? null;
}
