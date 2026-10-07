import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createClineSessionFileReader, getClineSessionsPath } from "../../../src/terminal/cline-session-files";
import { createTempDir } from "../../utilities/temp-dir";

interface SessionFixture {
	id: string;
	meta?: Record<string, unknown> | null;
	messages?: unknown;
	messagesMtimeMs?: number;
}

let cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups) {
		cleanup();
	}
	cleanups = [];
});

function createSessionsDir(fixtures: SessionFixture[]): string {
	const temp = createTempDir("kanban-cline-sessions-");
	cleanups.push(temp.cleanup);
	const sessionsPath = getClineSessionsPath(temp.path);
	for (const fixture of fixtures) {
		const dir = join(sessionsPath, fixture.id);
		mkdirSync(dir, { recursive: true });
		if (fixture.meta !== null) {
			writeFileSync(join(dir, `${fixture.id}.json`), JSON.stringify(fixture.meta ?? {}));
		}
		if (fixture.messages !== undefined) {
			const messagesPath = join(dir, `${fixture.id}.messages.json`);
			writeFileSync(messagesPath, JSON.stringify(fixture.messages));
			if (fixture.messagesMtimeMs !== undefined) {
				const seconds = fixture.messagesMtimeMs / 1000;
				utimesSync(messagesPath, seconds, seconds);
			}
		}
	}
	return sessionsPath;
}

const WORKTREE = "/home/u/worktrees/d70ca/foo";

describe("cline session file reader", () => {
	it("picks the newest cline 3.x session of the worktree, matched by workspace_root or cwd", async () => {
		const sessionsPath = createSessionsDir([
			{
				id: "1791335000000_old",
				meta: { status: "completed", started_at: "2026-10-07T01:00:00.000Z", cwd: WORKTREE },
				messages: { messages: [{ role: "user", content: "old" }] },
			},
			{
				id: "1791335760135_38ara",
				meta: {
					status: "idle",
					started_at: "2026-10-07T01:16:00.138Z",
					cwd: "/elsewhere",
					workspace_root: `${WORKTREE}/`,
				},
				messages: {
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "STATUS: DONE" }, { type: "reasoning" }] },
					],
				},
				messagesMtimeMs: 1_791_336_135_000,
			},
			{
				id: "1791335999999_other",
				meta: { status: "idle", started_at: "2026-10-07T02:00:00.000Z", cwd: "/home/u/worktrees/aaaaa/foo" },
				messages: { messages: [] },
			},
			// Embedded Cline SDK dirs are named after the card; this fork has no such agent.
			{ id: "d70ca-1791335760135-x", meta: { status: "idle", cwd: WORKTREE }, messages: { messages: [] } },
		]);

		const snapshot = await createClineSessionFileReader().readLatestSession(sessionsPath, WORKTREE);

		expect(snapshot).toEqual({
			sessionId: "1791335760135_38ara",
			status: "idle",
			startedAt: Date.parse("2026-10-07T01:16:00.138Z"),
			messagesWrittenAt: 1_791_336_135_000,
			lastMessage: {
				role: "assistant",
				content: [{ type: "text", text: "STATUS: DONE" }, { type: "reasoning" }],
			},
		});
	});

	it("returns null without a matching session or sessions dir", async () => {
		const sessionsPath = createSessionsDir([{ id: "1_a", meta: { cwd: "/other" }, messages: { messages: [] } }]);
		const reader = createClineSessionFileReader();

		expect(await reader.readLatestSession(sessionsPath, WORKTREE)).toBeNull();
		expect(await reader.readLatestSession(join(sessionsPath, "missing"), WORKTREE)).toBeNull();
	});

	it("reports no message while the messages file is missing, and finds a session once its meta is written", async () => {
		const sessionsPath = createSessionsDir([{ id: "5_late", meta: null }]);
		const reader = createClineSessionFileReader();
		expect(await reader.readLatestSession(sessionsPath, WORKTREE)).toBeNull();

		writeFileSync(join(sessionsPath, "5_late", "5_late.json"), JSON.stringify({ status: "running", cwd: WORKTREE }));

		expect(await reader.readLatestSession(sessionsPath, WORKTREE)).toEqual({
			sessionId: "5_late",
			status: "running",
			startedAt: null,
			messagesWrittenAt: null,
			lastMessage: null,
		});
	});
});

describe("cline session messages", () => {
	it("returns every message of the worktree's newest session, in both file shapes", async () => {
		const toolUse = {
			role: "assistant",
			content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }],
		};
		const sessionsPath = createSessionsDir([
			{
				id: "1791335000000_old",
				meta: { status: "completed", started_at: "2026-10-07T01:00:00.000Z", cwd: WORKTREE },
				messages: [{ role: "user", content: "old" }],
			},
			{
				id: "1791335760135_new",
				meta: { status: "running", started_at: "2026-10-07T02:00:00.000Z", workspace_root: WORKTREE },
				messages: { messages: [{ role: "user", content: "review" }, toolUse] },
			},
			{
				id: "1791335760999_nomsg",
				meta: { status: "running", started_at: "2026-10-07T03:00:00.000Z", cwd: "/other" },
			},
		]);
		const reader = createClineSessionFileReader();
		expect(await reader.readLatestSessionMessages(sessionsPath, WORKTREE)).toEqual([
			{ role: "user", content: "review" },
			toolUse,
		]);
		expect(await reader.readLatestSessionMessages(sessionsPath, "/other")).toBeNull();
		expect(await reader.readLatestSessionMessages(sessionsPath, "/nowhere")).toBeNull();
	});
});
