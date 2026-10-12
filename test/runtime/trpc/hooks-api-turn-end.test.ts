import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeHookEvent,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { readTurnEnd, readTurnFinalMessage } from "../../../src/core/turn-final-message";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";

// Each agent's hook order at a turn end, as its adapter's hooks report it (agent-session-adapters.ts), through the real
// ingest route and session manager: the turn end is read by readTurnFinalMessage whatever hook comes after it in the
// same Review, and never after the next turn started.

const T0 = Date.parse("2026-10-12T09:00:00.000Z");

function createSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: T0,
		updatedAt: T0,
		lastOutputAt: T0,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
	};
}

describe("hook ingest turn ends", () => {
	let manager: TerminalSessionManager;
	let ingest: (event: RuntimeHookEvent, metadata?: Partial<RuntimeTaskHookActivity>) => Promise<void>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ "task-1": createSummary() });
		const api = createHooksApi({
			getWorkspacePathById: () => "/tmp/repo",
			ensureTerminalManagerForWorkspace: async () => manager,
			broadcastRuntimeWorkspaceStateUpdated: () => {},
			broadcastTaskReadyForReview: () => {},
			captureTaskTurnCheckpoint: async ({ turn }) => ({ turn, ref: `ref-${turn}`, commit: "abc", createdAt: T0 }),
			deleteTaskTurnCheckpointRef: async () => {},
		});
		ingest = async (event, metadata) => {
			vi.advanceTimersByTime(1_000);
			const response = await api.ingest({ taskId: "task-1", workspaceId: "ws", event, metadata });
			expect(response).toEqual({ ok: true });
		};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const summary = () => manager.getSummary("task-1");

	it("Claude Code: Stop then the idle Notification still reads the Stop's message", async () => {
		await ingest("to_in_progress", { source: "claude", hookEventName: "UserPromptSubmit" });
		await ingest("activity", { source: "claude", hookEventName: "PreToolUse", toolName: "Bash" });
		await ingest("to_in_progress", { source: "claude", hookEventName: "PostToolUse", toolName: "Bash" });
		await ingest("to_review", { source: "claude", hookEventName: "Stop", finalMessage: "All done. Land it?" });
		const stopAt = Date.now();
		await ingest("activity", {
			source: "claude",
			hookEventName: "Notification",
			notificationType: "idle_prompt",
			activityText: "Claude is waiting for your input",
		});

		expect(summary()?.latestHookActivity?.hookEventName).toBe("Notification");
		expect(readTurnEnd(summary())).toEqual({ at: stopAt, finalMessage: "All done. Land it?" });
	});

	it("Claude Code: the next prompt clears the turn end, and the same text in a later turn is a new turn end", async () => {
		await ingest("to_review", { source: "claude", hookEventName: "Stop", finalMessage: "Done." });
		const first = readTurnEnd(summary());
		expect(first?.finalMessage).toBe("Done.");

		await ingest("to_in_progress", { source: "claude", hookEventName: "UserPromptSubmit" });
		expect(summary()?.lastTurnEnd).toBeNull();
		expect(readTurnFinalMessage(summary())).toBeNull();

		await ingest("to_review", { source: "claude", hookEventName: "Stop", finalMessage: "Done." });
		const second = readTurnEnd(summary());
		expect(second?.finalMessage).toBe("Done.");
		expect(second?.at).toBeGreaterThan(first?.at ?? Number.POSITIVE_INFINITY);
	});

	it("Claude Code: a permission request mid-turn is no turn end, even with an older final message in the merge", async () => {
		await ingest("to_review", { source: "claude", hookEventName: "Stop", finalMessage: "Old turn." });
		await ingest("to_in_progress", { source: "claude", hookEventName: "UserPromptSubmit" });
		await ingest("to_review", { source: "claude", hookEventName: "PermissionRequest", toolName: "Bash" });

		expect(summary()?.state).toBe("awaiting_review");
		expect(summary()?.latestHookActivity?.finalMessage).toBe("Old turn.");
		expect(readTurnFinalMessage(summary())).toBeNull();
	});

	it("Codex: final_answer then task_complete in the same Review is one turn end", async () => {
		await ingest("to_review", { source: "codex", hookEventName: "agent_message", finalMessage: "Fixed it." });
		const first = readTurnEnd(summary());
		await ingest("to_review", { source: "codex", hookEventName: "task_complete", finalMessage: "Fixed it." });

		expect(first?.finalMessage).toBe("Fixed it.");
		expect(readTurnEnd(summary())).toEqual(first);
	});

	it("Copilot: agentStop then a notification still reads; a brief Review flip is cleared by the continuation", async () => {
		await ingest("to_review", { source: "copilot", hookEventName: "agentStop", finalMessage: "Step one done." });
		await ingest("to_in_progress", { source: "copilot", hookEventName: "userPromptSubmitted" });
		expect(readTurnFinalMessage(summary())).toBeNull();

		await ingest("to_review", { source: "copilot", hookEventName: "agentStop", finalMessage: "All steps done." });
		await ingest("activity", { source: "copilot", hookEventName: "notification" });
		expect(readTurnFinalMessage(summary())).toBe("All steps done.");
	});

	it("Cline: TaskComplete reads its result; a later hook in the same Review keeps it", async () => {
		await ingest("to_review", {
			source: "cline-cli",
			hookEventName: "TaskComplete",
			activityText: "Waiting for review",
			finalMessage: "Card finished.",
		});
		await ingest("activity", { source: "cline-cli", hookEventName: "Notification" });
		expect(readTurnFinalMessage(summary())).toBe("Card finished.");
	});

	it("a final message on an activity hook (Claude's SubagentStop) is no turn end", async () => {
		await ingest("activity", { source: "claude", hookEventName: "SubagentStop", finalMessage: "Subagent result." });
		expect(summary()?.lastTurnEnd ?? null).toBeNull();
		expect(readTurnFinalMessage(summary())).toBeNull();
	});
});
