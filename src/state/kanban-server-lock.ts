// `<home>/run/server.json`: written by a running Kanban server, removed on shutdown. Commands that must
// not run beside a server for a given home (`kanban home migrate`) read it.
//
// A record outlives its server after a crash, SIGKILL or forced exit, and pids get reused. In a container
// the server gets about the same low pid every time (2, or a little more behind the image's kanban-entrypoint),
// so the next `podman run ... kanban <command>` can get that pid too.
// So a record only counts as live when its pid is not this process, the process exists, and it is the
// same process: same start time (Linux /proc/<pid>/stat), or, for records without one, a command line
// that mentions kanban.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { getKanbanHomePath, getKanbanRunPath } from "./kanban-home";

const SERVER_LOCK_FILENAME = "server.json";
// /proc/<pid>/stat field 22 (starttime, clock ticks since boot). Fields after the ")" of comm start at 3.
const PROC_STAT_STARTTIME_INDEX = 22 - 3;

const kanbanServerLockSchema = z.object({
	pid: z.number().int().positive(),
	url: z.string(),
	homePath: z.string(),
	startedAt: z.number(),
	/** Process start time from /proc/<pid>/stat; null where /proc is not available. */
	processStartTime: z.string().nullable().optional(),
});
export type KanbanServerLock = z.infer<typeof kanbanServerLockSchema>;

export function getKanbanServerLockPath(homePath = getKanbanHomePath()): string {
	return join(getKanbanRunPath(homePath), SERVER_LOCK_FILENAME);
}

/** The kernel's start time of `pid` (Linux only), or null when it cannot be read. */
export function readProcessStartTime(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat
			.slice(stat.lastIndexOf(")") + 1)
			.trim()
			.split(/\s+/u);
		return fields[PROC_STAT_STARTTIME_INDEX] ?? null;
	} catch {
		return null;
	}
}

function readProcessCommandLine(pid: number): string | null {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
	} catch {
		return null;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isLockProcessAlive(lock: KanbanServerLock): boolean {
	if (lock.pid === process.pid || !processExists(lock.pid)) {
		return false;
	}
	if (lock.processStartTime) {
		const startTime = readProcessStartTime(lock.pid);
		return startTime === null || startTime === lock.processStartTime;
	}
	const commandLine = readProcessCommandLine(lock.pid);
	return commandLine === null || /kanban/iu.test(commandLine);
}

function readKanbanServerLock(homePath: string): KanbanServerLock | null {
	try {
		const parsed = kanbanServerLockSchema.safeParse(
			JSON.parse(readFileSync(getKanbanServerLockPath(homePath), "utf8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** The server recorded in `<homePath>/run/server.json`, if that process is still the one running. */
export function readLiveKanbanServerLock(homePath: string): KanbanServerLock | null {
	const lock = readKanbanServerLock(homePath);
	return lock && isLockProcessAlive(lock) ? lock : null;
}

/** Records this process as the server for the current home. Returns the release function for shutdown. */
export function writeKanbanServerLock(url: string, warn: (message: string) => void): () => void {
	const homePath = getKanbanHomePath();
	const lockPath = getKanbanServerLockPath(homePath);
	const lock: KanbanServerLock = {
		pid: process.pid,
		url,
		homePath,
		startedAt: Date.now(),
		processStartTime: readProcessStartTime(process.pid),
	};
	try {
		mkdirSync(getKanbanRunPath(homePath), { recursive: true });
		writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
	} catch (error) {
		// Only migration checks read the record; a read-only home must not stop the server.
		warn(`Could not write ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
		return () => {};
	}
	return () => {
		// Another server may have taken the home over since; only remove our own record.
		if (readKanbanServerLock(homePath)?.pid === process.pid) {
			rmSync(lockPath, { force: true });
		}
	};
}
