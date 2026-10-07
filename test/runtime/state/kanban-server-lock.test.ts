import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	getKanbanServerLockPath,
	readLiveKanbanServerLock,
	readProcessStartTime,
	writeKanbanServerLock,
} from "../../../src/state/kanban-server-lock";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const hasProc = existsSync("/proc/self/stat");

function writeLock(homePath: string, lock: Record<string, unknown>): void {
	const path = getKanbanServerLockPath(homePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:3484", homePath, startedAt: 1, ...lock }), "utf8");
}

const children: ChildProcess[] = [];

function startProcess(marker: string): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", marker], { stdio: "ignore" });
	children.push(child);
	return child;
}

describe("kanban server lock", () => {
	afterEach(() => {
		for (const child of children.splice(0)) {
			child.kill();
		}
	});

	it("records this process on start and removes the record on release", async () => {
		await withTemporaryKanbanHome(({ homePath }) => {
			const release = writeKanbanServerLock("http://127.0.0.1:3484", () => {});
			expect(existsSync(getKanbanServerLockPath(homePath))).toBe(true);
			// A record naming this very process is never a live server to this process.
			expect(readLiveKanbanServerLock(homePath)).toBeNull();
			release();
			expect(existsSync(getKanbanServerLockPath(homePath))).toBe(false);
		});
	});

	it("ignores a record whose pid is gone", async () => {
		await withTemporaryKanbanHome(({ homePath }) => {
			const exited = spawnSync(process.execPath, ["-e", ""]);
			writeLock(homePath, { pid: exited.pid });
			expect(readLiveKanbanServerLock(homePath)).toBeNull();
		});
	});

	it.runIf(hasProc)("tells a reused pid from the recorded server by its start time", async () => {
		await withTemporaryKanbanHome(({ homePath }) => {
			const server = startProcess("kanban-server");
			const pid = server.pid ?? 0;
			const startTime = readProcessStartTime(pid);
			expect(startTime).toMatch(/^\d+$/u);

			writeLock(homePath, { pid, processStartTime: startTime });
			expect(readLiveKanbanServerLock(homePath)?.pid).toBe(pid);

			// Same pid, different process (the record outlived its server and the pid came back).
			writeLock(homePath, { pid, processStartTime: "1" });
			expect(readLiveKanbanServerLock(homePath)).toBeNull();
		});
	});

	it.runIf(hasProc)(
		"for a record without a start time, only counts a process whose command line mentions kanban",
		async () => {
			await withTemporaryKanbanHome(({ homePath }) => {
				const other = startProcess("some-other-daemon");
				writeLock(homePath, { pid: other.pid });
				expect(readLiveKanbanServerLock(homePath)).toBeNull();

				const server = startProcess("kanban-server");
				writeLock(homePath, { pid: server.pid });
				expect(readLiveKanbanServerLock(homePath)?.pid).toBe(server.pid);
			});
		},
	);

	it("does not stop the server when the record cannot be written", async () => {
		await withTemporaryKanbanHome(({ homePath }) => {
			mkdirSync(homePath, { recursive: true });
			writeFileSync(join(homePath, "run"), "", "utf8");
			const warnings: string[] = [];
			const release = writeKanbanServerLock("http://127.0.0.1:3484", (message) => warnings.push(message));
			expect(warnings).toHaveLength(1);
			release();
		});
	});
});
