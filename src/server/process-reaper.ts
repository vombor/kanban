// Terminates processes left behind in task worktrees.
//
// Agents start dev servers with nohup/setsid/detached, so a card's processes are not all in its session's
// process group or parent chain. The reaper therefore matches by location: every process whose cwd or
// executable is inside the worktree, plus the session process tree captured before the session stopped.
// Termination is SIGTERM, a grace period, then SIGKILL for survivors.
//
// Callers: the Done workflow, task delete and project removal (through runtime-server.ts) reap one card's
// worktree before deleting it; the orphan sweeper (orphan-process-sweeper.ts) reaps leftovers periodically.
//
// Never touched: PID 0/1/2, kernel threads (PF_KTHREAD), the Kanban server and its ancestors, zombies
// (they are already dead; only their parent can reap them), and anything whose pid was reused since it
// was read.
//
// Never signalled either, only reported: processes other cards use. A process's cwd says which card started
// it, not who uses it. The Cline hub daemon (`--cline-hub-daemon`) runs in the worktree of whichever card
// started it first and serves every Cline card. The same goes for any process with incoming TCP connections
// from processes outside the card, accepted connections on a named unix socket (procfs can't tell who the
// clients are, so they count as outside), or children working in another card's worktree.
import { realpathSync } from "node:fs";

import type { RuntimeProcessReapAction } from "../core/api-contract";
import { isPathWithinRoot } from "../workspace/path-sandbox";
import {
	createProcProcessTableReader,
	getTcpPort,
	isProcessTableSupported,
	isTcpEstablished,
	isTcpListening,
	type ProcessEntry,
	type ProcessTableReader,
} from "./process-table";

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_POLL_MS = 200;
const KILL_WAIT_MS = 1_000;
const ALWAYS_PROTECTED_PIDS = [0, 1, 2];
export const CLINE_HUB_DAEMON_FLAG = "--cline-hub-daemon";

export interface ProcessReaperDependencies {
	/** Null where the process table can't be read (not Linux): every call is a no-op. */
	reader: ProcessTableReader | null;
	signal?: (pid: number, signal: NodeJS.Signals) => void;
	sleep?: (ms: number) => Promise<void>;
	/** The Kanban server's pid; it and its ancestors are never signalled. */
	serverPid?: number;
	graceMs?: number;
	pollMs?: number;
	/** Task worktree roots; a child working under one of them, outside its parent's card, makes the parent shared. */
	getWorktreeRoots?: () => string[];
	log?: (message: string) => void;
}

/** A process to terminate, with the worktree path(s) of the card it belongs to. */
export interface ReapTarget {
	entry: ProcessEntry;
	ownPaths: string[];
}

export interface ProcessReapOutcome {
	entry: ProcessEntry;
	action: Exclude<RuntimeProcessReapAction, "reported">;
	error?: string;
	/** For `shared_daemon` / `shared`: what uses the process. */
	detail?: string;
}

interface SharedVerdict {
	action: "shared_daemon" | "shared";
	detail: string;
}

export interface ProcessSnapshot {
	entries: ProcessEntry[];
	byPid: ReadonlyMap<number, ProcessEntry>;
	/** Pids that must never be signalled: PID 0/1/2, kernel threads, the server and its ancestors. */
	protectedPids: ReadonlySet<number>;
}

export interface WorktreeReapRequest {
	/** For log lines. */
	taskId: string;
	worktreePaths: string[];
	/** Session process ids (PTY children); their whole tree is reaped wherever its cwd is. */
	sessionPids: number[];
}

export interface PreparedWorktreeReap {
	reap: () => Promise<ProcessReapOutcome[]>;
}

export interface ProcessReaper {
	readonly supported: boolean;
	readonly serverPid: number;
	snapshot: () => Promise<ProcessSnapshot>;
	/** Signals the targets, except protected, zombie and shared processes (reported as `shared*`). */
	terminate: (targets: ReapTarget[]) => Promise<ProcessReapOutcome[]>;
	/** The targets `terminate` would leave running because other cards use them. Signals nothing. */
	findShared: (targets: ReapTarget[]) => Promise<ProcessReapOutcome[]>;
	/**
	 * Captures the session trees now (before the sessions are stopped and their children reparent), and
	 * returns `reap`, which terminates them plus everything found inside the worktree at that point.
	 */
	prepareWorktreeReap: (request: WorktreeReapRequest) => Promise<PreparedWorktreeReap>;
}

/** The path itself and, if it differs, its resolved real path (/proc reports real paths). */
export function expandPathVariants(paths: readonly string[]): string[] {
	const variants = new Set<string>();
	for (const path of paths) {
		variants.add(path);
		try {
			variants.add(realpathSync(path));
		} catch {
			// Missing paths have no real path; the literal one is still matched.
		}
	}
	return [...variants];
}

export function isProcessInPaths(entry: ProcessEntry, paths: readonly string[]): boolean {
	return paths.some(
		(path) =>
			(entry.cwd !== null && isPathWithinRoot(path, entry.cwd)) ||
			(entry.exe !== null && isPathWithinRoot(path, entry.exe)),
	);
}

export function collectDescendantPids(entries: readonly ProcessEntry[], rootPids: Iterable<number>): Set<number> {
	const childrenByParent = new Map<number, number[]>();
	for (const entry of entries) {
		const children = childrenByParent.get(entry.ppid) ?? [];
		children.push(entry.pid);
		childrenByParent.set(entry.ppid, children);
	}
	const result = new Set<number>();
	const queue = [...rootPids];
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		if (result.has(pid)) {
			continue;
		}
		result.add(pid);
		queue.push(...(childrenByParent.get(pid) ?? []));
	}
	return result;
}

/**
 * A live process the agent started that works in the card's worktree: a descendant of the agent's own process or of
 * a Cline hub daemon (which runs every hub-hosted card's tools), whose cwd or exe is inside `worktreePaths`. Recovery
 * asks this while a shell tool call is pending, so a long `npm test` isn't taken for a stall. A server the agent
 * detached (nohup/setsid) is reparented away from both and never counts, or it would hold the nudge for good.
 */
export function findAgentToolProcess(
	entries: readonly ProcessEntry[],
	input: { worktreePaths: readonly string[]; agentPid: number | null },
): ProcessEntry | null {
	const roots = entries
		.filter((entry) => entry.pid === input.agentPid || entry.command.includes(CLINE_HUB_DAEMON_FLAG))
		.map((entry) => entry.pid);
	if (roots.length === 0) {
		return null;
	}
	const rootSet = new Set(roots);
	const descendants = collectDescendantPids(entries, roots);
	const paths = expandPathVariants(input.worktreePaths);
	return (
		entries.find(
			(entry) =>
				descendants.has(entry.pid) &&
				!rootSet.has(entry.pid) &&
				entry.state !== "Z" &&
				!entry.kernelThread &&
				isProcessInPaths(entry, paths),
		) ?? null
	);
}

/** findAgentToolProcess on the live process table, described for logs; null where /proc can't be read. */
export type AgentToolProcessFinder = (worktreePath: string, agentPid: number | null) => Promise<string | null>;

export function createAgentToolProcessFinder(
	reader: ProcessTableReader | null = isProcessTableSupported() ? createProcProcessTableReader() : null,
): AgentToolProcessFinder {
	return async (worktreePath, agentPid) => {
		const entries = await reader?.list().catch(() => null);
		const entry = entries ? findAgentToolProcess(entries, { worktreePaths: [worktreePath], agentPid }) : null;
		return entry ? `pid ${entry.pid}: ${entry.command.slice(0, 120)}` : null;
	};
}

export function formatRss(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isSameProcess(a: ProcessEntry, b: ProcessEntry | null | undefined): boolean {
	return b !== null && b !== undefined && a.pid === b.pid && a.startTime === b.startTime;
}

function errorCode(error: unknown): string | null {
	return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : null;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProcessReaper(deps: ProcessReaperDependencies): ProcessReaper {
	const reader = deps.reader;
	const serverPid = deps.serverPid ?? process.pid;
	const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
	const sleep = deps.sleep ?? defaultSleep;
	const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

	const snapshot = async (): Promise<ProcessSnapshot> => {
		const entries = reader ? await reader.list() : [];
		const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
		const protectedPids = new Set<number>([...ALWAYS_PROTECTED_PIDS, serverPid]);
		for (const entry of entries) {
			if (entry.kernelThread) {
				protectedPids.add(entry.pid);
			}
		}
		// The server's ancestors: a server started from inside a task worktree must not reap its own shell.
		let ancestor = byPid.get(serverPid);
		while (ancestor && !protectedPids.has(ancestor.ppid)) {
			protectedPids.add(ancestor.ppid);
			ancestor = byPid.get(ancestor.ppid);
		}
		return { entries, byPid, protectedPids };
	};

	/** Alive means: same pid and start time, and not a zombie (a zombie has exited). */
	const isAlive = async (entry: ProcessEntry): Promise<boolean> => {
		const current = reader ? await reader.read(entry.pid) : null;
		return isSameProcess(entry, current) && current?.state !== "Z";
	};

	const send = (entry: ProcessEntry, sig: NodeJS.Signals): { sent: boolean; error?: string } => {
		try {
			signal(entry.pid, sig);
			return { sent: true };
		} catch (error) {
			if (errorCode(error) === "ESRCH") {
				return { sent: false };
			}
			return { sent: false, error: error instanceof Error ? error.message : String(error) };
		}
	};

	const filterAlive = async (entries: ProcessEntry[]): Promise<ProcessEntry[]> => {
		const alive: ProcessEntry[] = [];
		for (const entry of entries) {
			if (await isAlive(entry)) {
				alive.push(entry);
			}
		}
		return alive;
	};

	const waitForExit = async (entries: ProcessEntry[], timeoutMs: number): Promise<ProcessEntry[]> => {
		let alive = await filterAlive(entries);
		for (let waited = 0; alive.length > 0 && waited < timeoutMs; waited += pollMs) {
			await sleep(pollMs);
			alive = await filterAlive(alive);
		}
		return alive;
	};

	/** Finds the targets other cards use; see the header comment. */
	const findSharedTargets = async (
		targets: ReapTarget[],
		current: ProcessSnapshot,
	): Promise<Map<number, SharedVerdict>> => {
		const shared = new Map<number, SharedVerdict>();
		if (!reader) {
			return shared;
		}
		const roots = expandPathVariants(deps.getWorktreeRoots?.() ?? []);
		const cardPids = new Map<string, Set<number>>();
		for (const target of targets) {
			const key = target.ownPaths.join("\0");
			const pids = cardPids.get(key) ?? new Set<number>();
			pids.add(target.entry.pid);
			cardPids.set(key, pids);
		}
		const isOutsideCard = (target: ReapTarget, other: ProcessEntry): boolean =>
			!(cardPids.get(target.ownPaths.join("\0"))?.has(other.pid) ?? false) &&
			!isProcessInPaths(other, target.ownPaths);
		let socketOwners: Map<string, number> | null = null;
		const getSocketOwners = async (): Promise<Map<string, number>> => {
			if (!socketOwners) {
				socketOwners = new Map();
				for (const entry of current.entries) {
					if (entry.kernelThread || entry.state === "Z") {
						continue;
					}
					for (const inode of await reader.readSocketInodes(entry.pid)) {
						socketOwners.set(inode, entry.pid);
					}
				}
			}
			return socketOwners;
		};

		for (const target of targets) {
			const { entry } = target;
			if (entry.command.includes(CLINE_HUB_DAEMON_FLAG)) {
				shared.set(entry.pid, { action: "shared_daemon", detail: "Cline hub daemon, used by every Cline card" });
				continue;
			}
			const foreignChild = current.entries.find(
				(other) =>
					other.ppid === entry.pid &&
					isProcessInPaths(other, roots) &&
					isOutsideCard(target, other) &&
					!other.kernelThread,
			);
			if (foreignChild) {
				shared.set(entry.pid, {
					action: "shared",
					detail: `child pid ${foreignChild.pid} works in another worktree (${foreignChild.cwd ?? foreignChild.exe})`,
				});
				continue;
			}
			const owned = new Set(await reader.readSocketInodes(entry.pid));
			if (owned.size === 0) {
				continue;
			}
			const net = await reader.readNetSockets(entry.pid);
			const acceptedUnix = net.unix.find(
				(row) => owned.has(row.inode) && row.path && row.connected && !row.listening,
			);
			if (acceptedUnix) {
				shared.set(entry.pid, {
					action: "shared",
					detail: `accepts connections on unix socket ${acceptedUnix.path}`,
				});
				continue;
			}
			const listeningPorts = new Set(
				net.tcp.filter((row) => owned.has(row.inode) && isTcpListening(row)).map((row) => getTcpPort(row.local)),
			);
			const incoming = net.tcp.filter(
				(row) => owned.has(row.inode) && isTcpEstablished(row) && listeningPorts.has(getTcpPort(row.local)),
			);
			for (const connection of incoming) {
				// The client's end of a local connection is the row with the addresses swapped. None: a remote client.
				const peer = net.tcp.find((row) => row.local === connection.remote && row.remote === connection.local);
				if (!peer) {
					continue;
				}
				const peerPid = (await getSocketOwners()).get(peer.inode);
				const peerEntry = peerPid === undefined ? undefined : current.byPid.get(peerPid);
				if (peerEntry?.pid === entry.pid) {
					continue;
				}
				if (!peerEntry || isOutsideCard(target, peerEntry)) {
					shared.set(entry.pid, {
						action: "shared",
						detail: peerEntry
							? `connected from pid ${peerEntry.pid} outside the card: ${peerEntry.command}`
							: "connected from a local process that can't be identified",
					});
					break;
				}
			}
		}
		return shared;
	};

	const terminate = async (targets: ReapTarget[]): Promise<ProcessReapOutcome[]> => {
		if (!reader || targets.length === 0) {
			return [];
		}
		const current = await snapshot();
		const outcomes = new Map<number, ProcessReapOutcome>();
		const signalled: ProcessEntry[] = [];
		const unique = new Map(
			targets
				.filter(({ entry }) => !current.protectedPids.has(entry.pid) && entry.state !== "Z" && !entry.kernelThread)
				.map((target) => [target.entry.pid, target]),
		);
		const shared = await findSharedTargets([...unique.values()], current);
		for (const [pid, verdict] of shared) {
			const target = unique.get(pid);
			if (target) {
				outcomes.set(pid, { entry: target.entry, ...verdict });
			}
		}
		for (const { entry } of unique.values()) {
			if (shared.has(entry.pid)) {
				continue;
			}
			// Re-read right before signalling, so a pid reused since the scan is left alone.
			if (!(await isAlive(entry))) {
				continue;
			}
			const result = send(entry, "SIGTERM");
			if (result.error) {
				outcomes.set(entry.pid, { entry, action: "failed", error: result.error });
				continue;
			}
			outcomes.set(entry.pid, { entry, action: "terminated" });
			if (result.sent) {
				signalled.push(entry);
			}
		}
		const survivors = await waitForExit(signalled, graceMs);
		for (const entry of survivors) {
			const result = send(entry, "SIGKILL");
			outcomes.set(
				entry.pid,
				result.error ? { entry, action: "failed", error: result.error } : { entry, action: "killed" },
			);
		}
		for (const entry of await waitForExit(survivors, KILL_WAIT_MS)) {
			outcomes.set(entry.pid, { entry, action: "failed", error: "Still running after SIGKILL." });
		}
		return [...outcomes.values()];
	};

	const prepareWorktreeReap = async (request: WorktreeReapRequest): Promise<PreparedWorktreeReap> => {
		if (!reader) {
			return { reap: async () => [] };
		}
		const paths = expandPathVariants(request.worktreePaths);
		const before = await snapshot();
		const sessionPids = request.sessionPids.filter((pid) => before.byPid.has(pid));
		const sessionTree = [...collectDescendantPids(before.entries, sessionPids)]
			.map((pid) => before.byPid.get(pid))
			.filter((entry): entry is ProcessEntry => entry !== undefined);
		return {
			reap: async () => {
				const now = await snapshot();
				const targets = [
					...sessionTree.filter((entry) => isSameProcess(entry, now.byPid.get(entry.pid))),
					...now.entries.filter((entry) => isProcessInPaths(entry, paths)),
				].map((entry) => ({ entry, ownPaths: paths }));
				const outcomes = await terminate(targets);
				for (const outcome of outcomes) {
					const note = outcome.error ?? outcome.detail;
					deps.log?.(
						`[process-reaper] ${outcome.action} pid ${outcome.entry.pid} of card ${request.taskId} (${formatRss(outcome.entry.rssBytes)}): ${outcome.entry.command}${note ? ` (${note})` : ""}`,
					);
				}
				return outcomes;
			},
		};
	};

	return {
		supported: reader !== null,
		serverPid,
		snapshot,
		terminate,
		findShared: async (targets) => {
			if (!reader || targets.length === 0) {
				return [];
			}
			const current = await snapshot();
			const shared = await findSharedTargets(targets, current);
			return targets.flatMap(({ entry }) => {
				const verdict = shared.get(entry.pid);
				return verdict ? [{ entry, ...verdict }] : [];
			});
		},
		prepareWorktreeReap,
	};
}
