import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { getTaskWorktreesHomePath } from "../../../src/state/workspace-state";
import { CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS } from "../../../src/terminal/claude-workspace-trust";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
}

const ARROW_DOWN = "\u001b[B";
const DIALOG_FIRST_RENDER =
	"Accessing workspace:\r\n Quick safety check: Is this a project you created or one you trust?\r\n" +
	"\u001b[2G\u001b[38;2;177;185;249m❯\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n";
const DIALOG_AFTER_ARROW_DOWN =
	"\u001b[1C\u001b[4A \u001b[4GNo, exit\r\u001b[1C\u001b[1B\u001b[38;2;177;185;249m❯\u001b[4GYes, I trust this folder\u001b[39m\r\r\n";

async function startClaudeSession() {
	const write = vi.fn();
	let request: MockSpawnRequest = {};
	ptySessionSpawnMock.mockImplementation((spawnRequest: MockSpawnRequest) => {
		request = spawnRequest;
		return {
			pid: 111,
			write,
			resize: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			stop: vi.fn(),
			wasInterrupted: vi.fn(() => false),
		};
	});
	const manager = new TerminalSessionManager();
	await manager.startTaskSession({
		taskId: "task-1",
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: join(getTaskWorktreesHomePath(), "task-1", "app"),
		prompt: "Fix the bug",
	});
	const output = (text: string) => request.onData?.(Buffer.from(text, "utf8"));
	return { manager, write, output };
}

describe("TerminalSessionManager Claude trust dialog fallback", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits past the dialog's input guard, moves off 'No, exit', then confirms", async () => {
		const { write, output } = await startClaudeSession();

		output(DIALOG_FIRST_RENDER);
		// The dialog drops keys for 150 ms after opening; the old 100 ms Enter was one of them.
		vi.advanceTimersByTime(CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS - 1);
		expect(write).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(write.mock.calls).toEqual([[ARROW_DOWN]]);

		output(DIALOG_AFTER_ARROW_DOWN);
		vi.advanceTimersByTime(CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS);
		expect(write.mock.calls).toEqual([[ARROW_DOWN], ["\r"]]);

		output("more output after the dialog closed");
		vi.advanceTimersByTime(CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS * 4);
		expect(write).toHaveBeenCalledTimes(2);
	});

	it("never sends Enter while 'No, exit' stays focused", async () => {
		const { write, output } = await startClaudeSession();

		output(DIALOG_FIRST_RENDER);
		for (let render = 0; render < 6; render += 1) {
			vi.advanceTimersByTime(CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS);
			output(DIALOG_FIRST_RENDER);
		}
		vi.advanceTimersByTime(CLAUDE_WORKSPACE_TRUST_KEY_DELAY_MS);
		expect(write.mock.calls.every(([input]) => input === ARROW_DOWN)).toBe(true);
		expect(write).toHaveBeenCalledTimes(3);
	});
});
