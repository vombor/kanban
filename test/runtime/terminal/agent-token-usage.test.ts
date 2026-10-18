import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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

function createSources(): { root: string; sources: AgentTokenUsageSources } {
	const temp = createTempDir("kanban-token-usage-");
	cleanups.push(temp.cleanup);
	const sources: AgentTokenUsageSources = {
		claudeProjectsPath: join(temp.path, "claude", "projects"),
		clineSessionsPath: join(temp.path, "cline", "sessions"),
		codexSessionsPath: join(temp.path, "codex", "sessions"),
		copilotSessionStatePath: join(temp.path, "copilot", "session-state"),
	};
	return { root: temp.path, sources };
}

const jsonl = (records: unknown[]): string => records.map((record) => `${JSON.stringify(record)}\n`).join("");

function claudeAssistant(id: string, usage: Record<string, number>): Record<string, unknown> {
	return { type: "assistant", message: { id, role: "assistant", usage } };
}

function writeClaudeTranscript(
	sources: AgentTokenUsageSources,
	worktree: string,
	name: string,
	records: unknown[],
): string {
	const dir = getClaudeProjectTranscriptDir(sources.claudeProjectsPath, worktree);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, jsonl(records));
	return path;
}

function writeClineSession(sources: AgentTokenUsageSources, id: string, cwd: string, messages: unknown[]): void {
	const dir = join(sources.clineSessionsPath, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ cwd, status: "completed" }));
	writeFileSync(join(dir, `${id}.messages.json`), JSON.stringify({ messages }));
}

function writeCodexRollout(sources: AgentTokenUsageSources, name: string, cwd: string, records: unknown[]): string {
	const dir = join(sources.codexSessionsPath, "2026", "10", "12");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, jsonl([{ type: "session_meta", payload: { cwd } }, ...records]));
	return path;
}

function codexTokenCount(total: number, last: Record<string, number>): Record<string, unknown> {
	return {
		type: "event_msg",
		payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last } },
	};
}

function writeCopilotSession(sources: AgentTokenUsageSources, id: string, cwd: string, records: unknown[]): string {
	const dir = join(sources.copilotSessionStatePath, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\nupdated_at: 2026-10-12T00:00:00Z\n`);
	const path = join(dir, "events.jsonl");
	writeFileSync(path, jsonl(records));
	return path;
}

function copilotShutdown(input: number, output: number, cacheRead: number): Record<string, unknown> {
	return {
		type: "session.shutdown",
		data: {
			tokenDetails: {
				input: { tokenCount: input },
				output: { tokenCount: output },
				cache_read: { tokenCount: cacheRead },
				cache_write: { tokenCount: 0 },
			},
		},
	};
}

describe("createAgentTokenUsageReader", () => {
	it("native observations retain Cline's actual per-message provider, cache semantics and unknown usage without transcript content", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "native", "repo");
		const messages = [
			{
				id: "request-1",
				role: "assistant",
				ts: Date.parse("2026-10-18T10:00:00Z"),
				modelInfo: { id: "fixture-model", provider: "bedrock" },
				metrics: { inputTokens: 130, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 10 },
				content: [{ type: "text", text: "private answer must not persist" }],
			},
			{
				id: "request-2",
				role: "assistant",
				ts: Date.parse("2026-10-18T10:01:00Z"),
				modelInfo: { id: "fixture-model", provider: "lemonade" },
				content: [{ type: "tool_use", name: "editor", input: { new_text: "private source" } }],
			},
		];
		writeClineSession(sources, "1792290000000_one", worktree, messages);
		writeClineSession(sources, "1792290001000_two", worktree, messages);
		const reader = createAgentTokenUsageReader();
		const usage = (await reader.read([worktree], sources, { observations: true })).get(worktree);
		expect(usage?.observations).toHaveLength(2);
		expect(usage?.observations?.[0]).toMatchObject({
			agent: "cline",
			provider: "bedrock",
			tokens: { input: 20, output: 5, cacheRead: 100, cacheWrite: 10 },
			uncertainty: [],
		});
		expect(usage?.observations?.[1]?.tokens).toBeNull();
		expect(usage?.observations?.[1]?.uncertainty).toContain("usage_missing");
		expect(JSON.stringify(usage?.observations)).not.toContain("private");
		expect((await reader.read([worktree], sources)).get(worktree)).not.toHaveProperty("observations");
	});
	it("Copilot's mixed/late totals remain session-level uncertainty, never a guessed billing route", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "mixed", "repo");
		writeCopilotSession(sources, "mixed", worktree, [
			{ type: "assistant.message", timestamp: "2026-10-18T10:00:00Z", data: { model: "one" } },
			{ type: "assistant.message", timestamp: "2026-10-18T10:01:00Z", data: { model: "two" } },
			copilotShutdown(10, 5, 2),
		]);
		const rows = (await createAgentTokenUsageReader().read([worktree], sources, { observations: true })).get(
			worktree,
		)?.observations;
		expect(rows?.[0]).toMatchObject({ basis: "session_total", provider: null, model: null });
		expect(rows?.[0]?.uncertainty).toEqual(
			expect.arrayContaining(["mixed_model", "provider_missing", "time_missing"]),
		);
	});
	it("counts a Claude Code transcript once per message id, keeping the last line of each", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "abc12", "repo");
		writeClaudeTranscript(sources, worktree, "s1.jsonl", [
			{ type: "user", message: { role: "user", content: "go" } },
			claudeAssistant("msg_1", {
				input_tokens: 2,
				output_tokens: 10,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 50,
			}),
			claudeAssistant("msg_1", {
				input_tokens: 2,
				output_tokens: 40,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 50,
			}),
			claudeAssistant("msg_2", {
				input_tokens: 3,
				output_tokens: 5,
				cache_read_input_tokens: 150,
				cache_creation_input_tokens: 0,
			}),
		]);
		// A continued conversation copies earlier messages into a new file: counted once.
		writeClaudeTranscript(sources, worktree, "s2.jsonl", [
			claudeAssistant("msg_2", {
				input_tokens: 3,
				output_tokens: 5,
				cache_read_input_tokens: 150,
				cache_creation_input_tokens: 0,
			}),
		]);

		const usage = await createAgentTokenUsageReader().read([worktree], sources);

		expect(usage.get(worktree)?.counts).toEqual({ input: 5, output: 45, cacheRead: 250, cacheWrite: 50 });
	});

	it("reads appended lines on the next call and starts over when a file shrinks", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "abc12", "repo");
		const path = writeClaudeTranscript(sources, worktree, "s1.jsonl", [
			claudeAssistant("msg_1", { input_tokens: 1, output_tokens: 1 }),
		]);
		const reader = createAgentTokenUsageReader();
		expect((await reader.read([worktree], sources)).get(worktree)?.counts.output).toBe(1);

		appendFileSync(path, jsonl([claudeAssistant("msg_2", { input_tokens: 1, output_tokens: 9 })]));
		// A line still being written isn't read until it ends.
		appendFileSync(path, '{"type":"assistant","message":{"id":"msg_3","usage":{"output_tokens":');
		expect((await reader.read([worktree], sources)).get(worktree)?.counts).toMatchObject({ input: 2, output: 10 });

		appendFileSync(path, "100}}}\n");
		expect((await reader.read([worktree], sources)).get(worktree)?.counts).toMatchObject({ output: 110 });

		writeFileSync(path, jsonl([claudeAssistant("msg_9", { input_tokens: 7, output_tokens: 7 })]));
		expect((await reader.read([worktree], sources)).get(worktree)?.counts).toMatchObject({ input: 7, output: 7 });
	});

	it("counts Cline sessions in the worktree, de-duplicated across resumed sessions, without the totals message or the cached input", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "abc12", "repo");
		const turn = (
			id: string,
			inputTokens: number,
			outputTokens: number,
			content: unknown[] = [{ type: "text" }],
		) => ({
			id,
			role: "assistant",
			content,
			metrics: { inputTokens, outputTokens, cacheReadTokens: 10, cacheWriteTokens: 1 },
		});
		writeClineSession(sources, "1791000000000_aaaa", worktree, [
			{ id: "u1", role: "user", content: [] },
			turn("a1", 100, 10),
			turn("a2", 200, 20),
			// The empty trailing message with the session's cumulative totals.
			turn("a3", 300, 30, []),
		]);
		writeClineSession(sources, "1791000000001_bbbb", join(worktree, "sub"), [turn("a2", 200, 20), turn("b1", 50, 5)]);
		writeClineSession(sources, "1791000000002_cccc", join(root, "worktrees", "other", "repo"), [turn("c1", 999, 9)]);

		const usage = await createAgentTokenUsageReader().read([worktree], sources);

		expect(usage.get(worktree)?.counts).toEqual({ input: 317, output: 35, cacheRead: 30, cacheWrite: 3 });
	});

	it("counts Codex rollouts by their session cwd, input without the cached part", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "abc12", "repo");
		const path = writeCodexRollout(sources, "rollout-2026-10-12T00-00-00-x.jsonl", worktree, [
			codexTokenCount(130, { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10 }),
			// The same total again is no new turn.
			codexTokenCount(130, { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10 }),
		]);
		writeCodexRollout(sources, "rollout-2026-10-12T00-00-01-y.jsonl", join(root, "elsewhere"), [
			codexTokenCount(5, { input_tokens: 5, output_tokens: 0 }),
		]);
		const reader = createAgentTokenUsageReader();

		expect((await reader.read([worktree], sources)).get(worktree)?.counts).toEqual({
			input: 20,
			output: 10,
			cacheRead: 100,
			cacheWrite: 0,
		});
		appendFileSync(
			path,
			jsonl([codexTokenCount(200, { input_tokens: 60, cached_input_tokens: 50, output_tokens: 10 })]),
		);
		expect((await reader.read([worktree], sources)).get(worktree)?.counts).toEqual({
			input: 30,
			output: 20,
			cacheRead: 150,
			cacheWrite: 0,
		});
	});

	it("counts a Copilot session from its last shutdown totals", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "abc12", "repo");
		const path = writeCopilotSession(sources, "8f1c", worktree, [{ type: "session.start", data: {} }]);
		const reader = createAgentTokenUsageReader();
		// No totals until the session shuts down.
		expect((await reader.read([worktree], sources)).has(worktree)).toBe(false);

		appendFileSync(path, jsonl([copilotShutdown(100, 10, 1000)]));
		expect((await reader.read([worktree], sources)).get(worktree)?.counts).toEqual({
			input: 100,
			output: 10,
			cacheRead: 1000,
			cacheWrite: 0,
		});
		// A resumed session's next shutdown carries the session's totals again.
		appendFileSync(path, jsonl([copilotShutdown(150, 20, 1500)]));
		expect((await reader.read([worktree], sources)).get(worktree)?.counts).toMatchObject({ input: 150, output: 20 });
	});

	it("adds up every agent that ran in the worktree and leaves out worktrees with nothing", async () => {
		const { root, sources } = createSources();
		const worktree = join(root, "worktrees", "abc12", "repo");
		const idle = join(root, "worktrees", "idle1", "repo");
		writeClaudeTranscript(sources, worktree, "s1.jsonl", [
			claudeAssistant("m", { input_tokens: 1, output_tokens: 2 }),
		]);
		writeCopilotSession(sources, "9a", worktree, [copilotShutdown(10, 20, 0)]);

		const usage = await createAgentTokenUsageReader().read([worktree, idle], sources);

		expect(usage.get(worktree)?.counts).toEqual({ input: 11, output: 22, cacheRead: 0, cacheWrite: 0 });
		expect(usage.has(idle)).toBe(false);
	});

	describe("models used", () => {
		it("reads Claude Code's message.model by line time, without its <synthetic> error lines", async () => {
			const { root, sources } = createSources();
			const worktree = join(root, "worktrees", "abc12", "repo");
			const line = (id: string, model: string, timestamp: string) => ({
				type: "assistant",
				timestamp,
				message: { id, model, role: "assistant", usage: { input_tokens: 1, output_tokens: 1 } },
			});
			writeClaudeTranscript(sources, worktree, "s1.jsonl", [
				line("m1", "claude-haiku-5-5", "2026-10-13T08:00:00.000Z"),
				line("m2", "claude-opus-5-5", "2026-10-13T09:00:00.000Z"),
				line("m3", "<synthetic>", "2026-10-13T10:00:00.000Z"),
			]);
			// An older session in the same worktree: haiku was used there last at 08:30, opus stays the latest.
			writeClaudeTranscript(sources, worktree, "s0.jsonl", [
				line("m0", "claude-haiku-5-5", "2026-10-13T08:30:00.000Z"),
			]);

			const usage = await createAgentTokenUsageReader().read([worktree], sources);

			expect(usage.get(worktree)?.models).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
		});

		it("reads Cline's modelInfo.id, but not from its own error notices", async () => {
			const { root, sources } = createSources();
			const worktree = join(root, "worktrees", "abc12", "repo");
			writeClineSession(sources, "1791000000000_aaaa", worktree, [
				{
					id: "msg_1",
					role: "assistant",
					content: [{ type: "text" }],
					ts: 1_791_000_000_000,
					modelInfo: { id: "Qwen3-Coder-Next-GGUF", provider: "lemonade" },
					metrics: { inputTokens: 10, outputTokens: 1 },
				},
				{
					id: "error_1",
					role: "assistant",
					content: [{ type: "text", text: "No model loaded: gemma-4-31B" }],
					ts: 1_791_000_001_000,
					modelInfo: { id: "gemma-4-31B", provider: "lemonade" },
					metadata: { displayOnly: true, displayRole: "error" },
				},
			]);

			const usage = await createAgentTokenUsageReader().read([worktree], sources);

			expect(usage.get(worktree)?.models).toEqual(["Qwen3-Coder-Next-GGUF"]);
		});

		it("reads Codex's turn_context model, a changed model coming first", async () => {
			const { root, sources } = createSources();
			const worktree = join(root, "worktrees", "abc12", "repo");
			const path = writeCodexRollout(sources, "rollout-2026-10-13T00-00-00-x.jsonl", worktree, [
				{
					timestamp: "2026-10-13T08:00:00.000Z",
					type: "turn_context",
					payload: { cwd: worktree, model: "gpt-6.1" },
				},
				codexTokenCount(10, { input_tokens: 10, output_tokens: 0 }),
			]);
			const reader = createAgentTokenUsageReader();
			expect((await reader.read([worktree], sources)).get(worktree)?.models).toEqual(["gpt-6.1"]);

			appendFileSync(
				path,
				jsonl([
					{
						timestamp: "2026-10-13T09:00:00.000Z",
						type: "turn_context",
						payload: { cwd: worktree, model: "gpt-6.1-sol" },
					},
				]),
			);
			expect((await reader.read([worktree], sources)).get(worktree)?.models).toEqual(["gpt-6.1-sol", "gpt-6.1"]);
		});

		it("reads Copilot's assistant.message model before the session's token totals exist", async () => {
			const { root, sources } = createSources();
			const worktree = join(root, "worktrees", "abc12", "repo");
			writeCopilotSession(sources, "8f1c", worktree, [
				{
					type: "session.start",
					timestamp: "2026-10-13T08:00:00.000Z",
					data: { selectedModel: "claude-sonnet-5.5" },
				},
				// Copilot's internal helper call, which never answered the card.
				{ type: "model.turn_started", timestamp: "2026-10-13T08:00:01.000Z", data: { model: "gpt-4o-mini" } },
				{ type: "assistant.message", timestamp: "2026-10-13T08:00:02.000Z", data: { model: "claude-sonnet-5.5" } },
			]);

			const usage = await createAgentTokenUsageReader().read([worktree], sources);

			expect(usage.get(worktree)).toEqual({
				counts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				models: ["claude-sonnet-5.5"],
			});
		});

		it("lists the models of every agent that ran in the worktree, most recently used first", async () => {
			const { root, sources } = createSources();
			const worktree = join(root, "worktrees", "abc12", "repo");
			writeClaudeTranscript(sources, worktree, "s1.jsonl", [
				{
					type: "assistant",
					timestamp: "2026-10-13T10:00:00.000Z",
					message: { id: "m1", model: "claude-opus-5-5", usage: { output_tokens: 1 } },
				},
			]);
			writeCopilotSession(sources, "9a", worktree, [
				{ type: "assistant.message", timestamp: "2026-10-13T09:00:00.000Z", data: { model: "gpt-5-mini" } },
				copilotShutdown(10, 20, 0),
			]);

			const usage = await createAgentTokenUsageReader().read([worktree], sources);

			expect(usage.get(worktree)?.models).toEqual(["claude-opus-5-5", "gpt-5-mini"]);
		});

		it("names no model for sessions whose records carry none", async () => {
			const { root, sources } = createSources();
			const worktree = join(root, "worktrees", "abc12", "repo");
			writeClaudeTranscript(sources, worktree, "s1.jsonl", [
				claudeAssistant("m", { input_tokens: 1, output_tokens: 2 }),
			]);

			const usage = await createAgentTokenUsageReader().read([worktree], sources);

			expect(usage.get(worktree)?.models).toEqual([]);
		});
	});

	it("answers with nothing when no agent has any session files", async () => {
		const { root, sources } = createSources();
		const usage = await createAgentTokenUsageReader().read([join(root, "worktrees", "abc12", "repo")], sources);
		expect(usage.size).toBe(0);
	});
});
