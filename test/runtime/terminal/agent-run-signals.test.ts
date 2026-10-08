import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { countToolUse, createAgentRunSignals, findRepeatedToolCall } from "../../../src/terminal/agent-run-signals";
import type { ClineSessionFileReader } from "../../../src/terminal/cline-session-files";
import { createTempDir } from "../../utilities/temp-dir";

const toolCall = (name: string, input: unknown) => ({
	role: "assistant",
	content: [{ type: "tool_use", name, input }],
});

const tempDirs: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	for (const temp of tempDirs.splice(0)) {
		temp.cleanup();
	}
	vi.unstubAllEnvs();
});

describe("tool-call signals", () => {
	it("finds the most repeated tool call within the last calls", () => {
		const messages = [
			toolCall("read_file", { path: "a" }),
			...Array.from({ length: 30 }, () => toolCall("execute_command", { command: "npx ts-node server.ts &" })),
			toolCall("read_file", { path: "b" }),
		];
		expect(findRepeatedToolCall(messages)).toEqual({
			count: 30,
			of: 32,
			call: 'execute_command {"command":"npx ts-node server.ts &"}',
		});
		// Only the last `last` calls count.
		expect(findRepeatedToolCall(messages, 2)?.count).toBe(1);
		expect(findRepeatedToolCall([{ role: "user", content: "hi" }])).toBeNull();
	});

	it("counts native tool calls against tool calls written as text", () => {
		const messages = [
			{ role: "user", content: "review it" },
			{ role: "assistant", content: "<run_commands>npm test</run_commands>" },
			{ role: "assistant", content: [{ type: "text", text: "<read_file>a.ts</read_file>" }] },
			toolCall("read_file", { path: "a" }),
		];
		expect(countToolUse(messages)).toEqual({ native: 1, textual: 2, turns: 3 });
	});
});

describe("createAgentRunSignals", () => {
	it("reads Cline's session files and answers null for agents without a profile", async () => {
		const reader: ClineSessionFileReader = {
			readLatestSession: vi.fn(async () => ({
				sessionId: "1_a",
				status: "running",
				startedAt: 1,
				messagesWrittenAt: 1,
				lastMessage: null,
			})),
			readLatestSessionMessages: vi.fn(async () => [toolCall("list_files", {}), toolCall("list_files", {})]),
		};
		const signals = createAgentRunSignals({ clineReader: reader, clineSessionsPath: "/cline/sessions" });
		expect(await signals.isSessionRunning("cline", "/wt/c1/repo")).toBe(true);
		expect(reader.readLatestSession).toHaveBeenCalledWith("/cline/sessions", "/wt/c1/repo");
		expect(await signals.findToolCallLoop("cline", "/wt/c1/repo")).toMatchObject({ count: 2, of: 2 });
		expect(await signals.countToolUse("cline", "/wt/c1/repo")).toEqual({ native: 2, textual: 0, turns: 2 });
		expect(await signals.isSessionRunning("codex", "/wt/c1/repo")).toBeNull();
		expect(await signals.findToolCallLoop("claude", "/wt/c1/repo")).toBeNull();
		expect(await signals.isSignedIn("cline")).toBeNull();
	});

	it("reads the Copilot login from its JSONC config (never a token env var, Kanban drops those), and its session events", async () => {
		const temp = createTempDir("kanban-copilot-");
		tempDirs.push(temp);
		vi.stubEnv("COPILOT_HOME", temp.path);
		const signals = createAgentRunSignals();
		const noToken = { PATH: "/usr/bin" };
		expect(await signals.isSignedIn("copilot", noToken)).toBe(false);
		expect(await signals.isSignedIn("copilot", { GH_TOKEN: "x", COPILOT_GITHUB_TOKEN: "y" })).toBe(false);
		await writeFile(join(temp.path, "config.json"), '// Copilot config\n{ "trustedFolders": [] }\n');
		expect(await signals.isSignedIn("copilot", noToken)).toBe(false);
		await writeFile(
			join(temp.path, "config.json"),
			'// Copilot config\n{ "loggedInUsers": [{ "login": "someone" }] }\n',
		);
		expect(await signals.isSignedIn("copilot", noToken)).toBe(true);
		expect(await signals.isSignedIn("copilot", { GH_TOKEN: "x" })).toBe(true);

		const worktree = "/wt/c2/repo";
		expect(await signals.hasStartedTurn("copilot", worktree)).toBe(false);
		const sessionDir = join(temp.path, "session-state", "s1");
		await mkdir(sessionDir, { recursive: true });
		await writeFile(join(sessionDir, "workspace.yaml"), `cwd: ${worktree}\nupdated_at: 2026-10-07T10:00:00Z\n`);
		expect(await signals.hasStartedTurn("copilot", worktree)).toBe(false);
		await writeFile(join(sessionDir, "events.jsonl"), "{}\n");
		expect(await signals.hasStartedTurn("copilot", worktree)).toBe(true);
		expect(await signals.hasStartedTurn("codex", worktree)).toBeNull();
	});
});
