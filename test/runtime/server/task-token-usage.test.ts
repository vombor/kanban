import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createTaskTokenUsageLoader } from "../../../src/server/task-token-usage";
import {
	type AgentSessionUsage,
	type AgentTokenUsageReader,
	type AgentTokenUsageSources,
	createAgentTokenUsageReader,
	getClaudeProjectTranscriptDir,
} from "../../../src/terminal/agent-token-usage";
import { createTempDir } from "../../utilities/temp-dir";

let cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups) {
		cleanup();
	}
	cleanups = [];
});

const SOURCES: AgentTokenUsageSources = {
	claudeProjectsPath: "/tmp/claude/projects",
	clineSessionsPath: "/tmp/cline/sessions",
	codexSessionsPath: "/tmp/codex/sessions",
	copilotSessionStatePath: "/tmp/copilot/session-state",
};

function card(id: string): RuntimeBoardCard {
	return { id, title: id, prompt: id, startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
}

function board(columns: Partial<Record<"backlog" | "in_progress" | "review" | "trash", string[]>>): RuntimeBoardData {
	return {
		columns: (["backlog", "in_progress", "review", "trash"] as const).map((id) => ({
			id,
			title: id,
			cards: (columns[id] ?? []).map(card),
		})),
		dependencies: [],
	};
}

function summary(taskId: string, workspacePath: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
	};
}

const counts = (output: number, models: string[] = []): AgentSessionUsage => ({
	counts: { input: 1, output, cacheRead: 0, cacheWrite: 0 },
	models,
});

describe("createTaskTokenUsageLoader", () => {
	it("measures every card past Backlog in its session's worktree, else the worktree Kanban would create", async () => {
		const read = vi.fn<AgentTokenUsageReader["read"]>(
			async () =>
				new Map([
					["/wt/aaaaa/repo-live", counts(10, ["claude-opus-5-5"])],
					["/home/wt/bbbbb/repo", counts(20)],
				]),
		);
		const load = createTaskTokenUsageLoader({
			reader: { read },
			loadBoard: async () =>
				board({ backlog: ["zzzzz"], in_progress: ["aaaaa"], review: ["bbbbb"], trash: ["ccccc"] }),
			readSources: async () => SOURCES,
			worktreesRootPath: () => "/home/wt",
		});

		const response = await load({ workspaceId: "ws", workspacePath: "/projects/repo" }, [
			summary("aaaaa", "/wt/aaaaa/repo-live"),
		]);

		expect(read).toHaveBeenCalledWith(["/wt/aaaaa/repo-live", "/home/wt/bbbbb/repo", "/home/wt/ccccc/repo"], SOURCES);
		expect(response.usage).toEqual([
			{ taskId: "aaaaa", input: 1, output: 10, cacheRead: 0, cacheWrite: 0, models: ["claude-opus-5-5"] },
			{ taskId: "bbbbb", input: 1, output: 20, cacheRead: 0, cacheWrite: 0, models: [] },
		]);
	});

	it("never measures a card that ran in the main checkout, and reads nothing for a Backlog-only board", async () => {
		const read = vi.fn<AgentTokenUsageReader["read"]>(async () => new Map());
		const load = createTaskTokenUsageLoader({
			reader: { read },
			loadBoard: async () => board({ in_progress: ["aaaaa"] }),
			readSources: async () => SOURCES,
			worktreesRootPath: () => "/home/wt",
		});

		expect(
			await load({ workspaceId: "ws", workspacePath: "/projects/repo" }, [summary("aaaaa", "/projects/repo/")]),
		).toEqual({ usage: [] });
		expect(read).not.toHaveBeenCalled();
	});

	it("keeps its session-file cache between calls: an unchanged file is not read again, a grown one is", async () => {
		const temp = createTempDir("kanban-task-token-usage-");
		cleanups.push(temp.cleanup);
		const sources: AgentTokenUsageSources = {
			claudeProjectsPath: join(temp.path, "claude", "projects"),
			clineSessionsPath: join(temp.path, "cline", "sessions"),
			codexSessionsPath: join(temp.path, "codex", "sessions"),
			copilotSessionStatePath: join(temp.path, "copilot", "session-state"),
		};
		const worktree = join(temp.path, "wt", "aaaaa", "repo");
		const dir = getClaudeProjectTranscriptDir(sources.claudeProjectsPath, worktree);
		mkdirSync(dir, { recursive: true });
		const transcript = join(dir, "session.jsonl");
		const line = (id: string, output: number) =>
			`${JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: output } } })}\n`;
		writeFileSync(transcript, line("m1", 100));
		const load = createTaskTokenUsageLoader({
			reader: createAgentTokenUsageReader(),
			loadBoard: async () => board({ in_progress: ["aaaaa"] }),
			readSources: async () => sources,
		});
		const scope = { workspaceId: "ws", workspacePath: "/projects/repo" };
		const summaries = [summary("aaaaa", worktree)];

		expect((await load(scope, summaries)).usage).toEqual([
			{ taskId: "aaaaa", input: 10, output: 100, cacheRead: 0, cacheWrite: 0, models: ["claude-opus-5-5"] },
		]);

		// Same size and mtime, other bytes: a cache hit answers the old count without reading the file.
		const { atime, mtime } = statSync(transcript);
		writeFileSync(transcript, line("m1", 900));
		utimesSync(transcript, atime, mtime);
		expect((await load(scope, summaries)).usage[0]?.output).toBe(100);

		// The agent appends a turn: only the new line is read.
		appendFileSync(transcript, line("m2", 50));
		expect((await load(scope, summaries)).usage).toEqual([
			{ taskId: "aaaaa", input: 20, output: 150, cacheRead: 0, cacheWrite: 0, models: ["claude-opus-5-5"] },
		]);
	});
});
