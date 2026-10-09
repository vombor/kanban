import { describe, expect, it } from "vitest";

import { parseHooksIngestArgs } from "../../src/commands/hooks";
import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../../src/core/api-contract";
import { describeUserInputWait } from "../../src/terminal/user-input-wait";

// From the agent's hook payload to "what does the orchestrator wait for" (issue #10): hook ingest must put the
// question and the tool asked about where the reader looks (the activity text), for Claude Code's payloads.
function ingest(event: RuntimeHookEvent, payload: Record<string, unknown>): RuntimeTaskHookActivity {
	const args = parseHooksIngestArgs(
		event,
		{ taskId: "__home_agent__:alpha:claude", workspaceId: "alpha", source: "claude" },
		undefined,
		JSON.stringify(payload),
	);
	return {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		hookEventName: null,
		notificationType: null,
		source: null,
		...args.metadata,
	};
}

describe("hook ingest → user input wait", () => {
	it("carries AskUserQuestion's question", () => {
		const latestHookActivity = ingest("activity", {
			hook_event_name: "PreToolUse",
			tool_name: "AskUserQuestion",
			tool_input: { questions: [{ question: "Which kit should foo use?", header: "Kit", options: [] }] },
		});
		expect(latestHookActivity.activityText).toBe("Using AskUserQuestion: Which kit should foo use?");
		expect(describeUserInputWait({ state: "running", lastHookAt: 1, latestHookActivity })).toEqual({
			kind: "question",
			since: 1,
			text: "Which kit should foo use?",
		});
	});

	it("carries the command a PermissionRequest asks about, and a permission Notification's message", () => {
		const permission = ingest("to_review", {
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			tool_input: { command: "git push origin main" },
		});
		expect(permission.activityText).toBe("Waiting for approval: Bash: git push origin main");
		expect(
			describeUserInputWait({ state: "awaiting_review", lastHookAt: 2, latestHookActivity: permission })?.text,
		).toBe("Bash: git push origin main");

		const notification = ingest("to_review", {
			hook_event_name: "Notification",
			notification_type: "permission_prompt",
			message: "Claude needs your permission to use Bash",
		});
		expect(notification.activityText).toBe("Waiting for approval: Claude needs your permission to use Bash");
		expect(
			describeUserInputWait({ state: "awaiting_review", lastHookAt: 3, latestHookActivity: notification }),
		).toEqual({
			kind: "approval",
			since: 3,
			text: "Claude needs your permission to use Bash",
		});
	});

	it("reads a Stop whose last message asks something as a question", () => {
		const latestHookActivity = ingest("to_review", {
			hook_event_name: "Stop",
			last_assistant_message: "Both cards are in Review.\n\nShould I start the QA cards now?",
		});
		expect(
			describeUserInputWait({ state: "awaiting_review", reviewReason: "hook", lastHookAt: 4, latestHookActivity }),
		).toMatchObject({ kind: "question", text: "Should I start the QA cards now?" });
	});
});
