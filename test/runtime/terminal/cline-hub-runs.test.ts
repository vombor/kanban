import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ClineHubConnection } from "../../../src/terminal/cline-hub-client";
import { createClineHubRunCanceller } from "../../../src/terminal/cline-hub-runs";
import { createClineSessionFileReader, getClineSessionsPath } from "../../../src/terminal/cline-session-files";
import { createTempDir } from "../../utilities/temp-dir";

const WORKTREE = "/home/u/worktrees/33288/foo";
const T0 = Date.parse("2026-10-10T10:43:00.000Z");

let cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups) {
		cleanup();
	}
	cleanups = [];
});

function createDataDir(sessions: Array<{ id: string; status: string; startedAt: number; cwd: string }>): string {
	const temp = createTempDir("kanban-cline-hub-runs-");
	cleanups.push(temp.cleanup);
	for (const session of sessions) {
		const dir = join(getClineSessionsPath(temp.path), session.id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${session.id}.json`),
			JSON.stringify({
				status: session.status,
				started_at: new Date(session.startedAt).toISOString(),
				cwd: session.cwd,
				workspace_root: session.cwd,
			}),
		);
	}
	return temp.path;
}

function createHarness(dataDir: string, options: { discovery?: boolean } = {}) {
	const aborted: string[] = [];
	const logs: string[] = [];
	let connects = 0;
	let closed = 0;
	const connection: ClineHubConnection = {
		command: async () => ({ ok: true }),
		close: () => {
			closed += 1;
		},
	};
	const canceller = createClineHubRunCanceller({
		loadClineDataDir: async () => dataDir,
		log: (message) => logs.push(message),
		readDiscovery: async () => (options.discovery === false ? null : { url: "ws://127.0.0.1:1/hub", authToken: "t" }),
		connect: async () => {
			connects += 1;
			return connection;
		},
		abort: async (_connection, sessionId) => {
			aborted.push(sessionId);
			return "ended";
		},
	});
	return { canceller, aborted, logs, stats: () => ({ connects, closed }) };
}

describe("cline hub run canceller", () => {
	it("ends every running session of the worktree, and only those (Done, delete)", async () => {
		const dataDir = createDataDir([
			{ id: "1791628989887_naxx0", status: "running", startedAt: T0, cwd: WORKTREE },
			{ id: "1791628900000_child", status: "running", startedAt: T0 + 1000, cwd: `${WORKTREE}/sub` },
			{ id: "1791628000000_done", status: "idle", startedAt: T0 - 60_000, cwd: WORKTREE },
			{ id: "1791628999999_other", status: "running", startedAt: T0, cwd: "/home/u/worktrees/1f153/foo" },
		]);
		const { canceller, aborted, stats } = createHarness(dataDir);
		const results = await canceller.cancelRuns({
			workspaceId: "foo",
			taskId: "33288",
			worktreePaths: [WORKTREE],
			reason: "done",
		});
		expect(aborted.sort()).toEqual(["1791628900000_child", "1791628989887_naxx0"]);
		expect(results.every((result) => result.outcome === "ended")).toBe(true);
		expect(stats()).toEqual({ connects: 1, closed: 1 });
	});

	it("ends only the sessions a run started when given its window (a relaunch's new session stays)", async () => {
		const dataDir = createDataDir([
			{ id: "1791628989887_old", status: "running", startedAt: T0 + 2_000, cwd: WORKTREE },
			{ id: "1791629999999_new", status: "running", startedAt: T0 + 120_000, cwd: WORKTREE },
		]);
		const { canceller, aborted } = createHarness(dataDir);
		await canceller.cancelRuns({
			workspaceId: "foo",
			taskId: "33288",
			worktreePaths: [WORKTREE],
			window: { from: T0, to: T0 + 100_000 },
			reason: "exit",
		});
		expect(aborted).toEqual(["1791628989887_old"]);
	});

	it("opens no hub connection when nothing of the worktree runs", async () => {
		const dataDir = createDataDir([{ id: "1791628000000_done", status: "idle", startedAt: T0, cwd: WORKTREE }]);
		const { canceller, stats } = createHarness(dataDir);
		expect(
			await canceller.cancelRuns({ workspaceId: "foo", taskId: "33288", worktreePaths: [WORKTREE], reason: "done" }),
		).toEqual([]);
		expect(stats().connects).toBe(0);
	});

	it("reports a running session it can't end when no hub discovery file is usable", async () => {
		const dataDir = createDataDir([{ id: "1791628989887_naxx0", status: "running", startedAt: T0, cwd: WORKTREE }]);
		const { canceller, logs, stats } = createHarness(dataDir, { discovery: false });
		const results = await canceller.cancelRuns({
			workspaceId: "foo",
			taskId: "33288",
			worktreePaths: [WORKTREE],
			reason: "done",
		});
		expect(results).toEqual([{ sessionId: "1791628989887_naxx0", outcome: "hub_unavailable" }]);
		expect(stats().connects).toBe(0);
		expect(logs[0]).toContain("1791628989887_naxx0");
	});

	it("reads a session's status anew each time (its cwd and start are cached)", async () => {
		const dataDir = createDataDir([{ id: "1791628989887_naxx0", status: "running", startedAt: T0, cwd: WORKTREE }]);
		const reader = createClineSessionFileReader();
		const sessionsPath = getClineSessionsPath(dataDir);
		expect(await reader.readRunningSessions(sessionsPath, [WORKTREE])).toEqual([
			{ sessionId: "1791628989887_naxx0", startedAt: T0 },
		]);
		writeFileSync(
			join(sessionsPath, "1791628989887_naxx0", "1791628989887_naxx0.json"),
			JSON.stringify({ status: "idle", started_at: new Date(T0).toISOString(), cwd: WORKTREE }),
		);
		expect(await reader.readRunningSessions(sessionsPath, [WORKTREE])).toEqual([]);
		expect(await reader.readRunningSessions(sessionsPath, ["/home/u/worktrees/33288/fo"])).toEqual([]);
	});
});
