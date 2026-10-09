import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	countToolUse,
	createAgentRunSignals,
	findEndingImageRejection,
	findRepeatedToolCall,
} from "../../../src/terminal/agent-run-signals";
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
			{ role: "user", content: "done" },
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

	it("never counts a tool call still waiting for its result (Gemma's first ls -R, 2026-10-09)", () => {
		const call = (id: string) => ({
			role: "assistant",
			content: [{ type: "tool_use", id, name: "run_commands", input: { commands: ["ls -R"] } }],
		});
		const result = (id: string) => ({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: id, content: "" }],
		});
		expect(findRepeatedToolCall([{ role: "user", content: "review it" }, call("t1")])).toBeNull();
		// Answered by id, wherever the result is; an unanswered id never counts, even with messages after it.
		expect(findRepeatedToolCall([call("t1"), result("t1"), call("t2"), result("t2"), call("t3")])).toMatchObject({
			count: 2,
			of: 2,
		});
		expect(findRepeatedToolCall([call("t1"), { role: "user", content: "go on" }])).toBeNull();
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

	it("tells a final 'no images' rejection from a reply that made a tool call or said something else", () => {
		const rejection = {
			role: "assistant",
			content: [{ type: "text", text: "This model doesn't support the image field for user messages." }],
		};
		expect(findEndingImageRejection([toolCall("read_files", {}), rejection])).toBe("unsupported");
		expect(findEndingImageRejection([rejection, toolCall("read_files", {})])).toBeNull();
		expect(findEndingImageRejection([rejection, { role: "assistant", content: "Done. STATUS: ok" }])).toBeNull();
		expect(findEndingImageRejection([{ role: "user", content: "hi" }])).toBeNull();
	});

	it("tells an image over the provider's size limits (issue #12)", () => {
		const rejection = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "messages.1.content.86.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels",
				},
			],
		};
		expect(findEndingImageRejection([toolCall("read_files", {}), rejection])).toBe("too_large");
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
			readLatestSessionMessages: vi.fn(async () => [
				toolCall("list_files", {}),
				toolCall("list_files", {}),
				{ role: "user", content: "next" },
			]),
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

	it("signs Copilot in through COPILOT_GITHUB_TOKEN or the login in its JSONC config (never the PAT), and reads its session events", async () => {
		const temp = createTempDir("kanban-copilot-");
		tempDirs.push(temp);
		vi.stubEnv("COPILOT_HOME", temp.path);
		const signals = createAgentRunSignals();
		const noToken = { PATH: "/usr/bin" };
		expect(await signals.isSignedIn("copilot", noToken)).toBe(false);
		expect(await signals.isSignedIn("copilot", { GH_TOKEN: "x", GITHUB_TOKEN: "x" })).toBe(false);
		expect(await signals.isSignedIn("copilot", { COPILOT_GITHUB_TOKEN: " " })).toBe(false);
		expect(await signals.isSignedIn("copilot", { COPILOT_GITHUB_TOKEN: "y" })).toBe(true);
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
