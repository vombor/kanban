import { describe, expect, it } from "vitest";

import type { RuntimeTaskHookActivity } from "../../../src/core/api-contract";
import {
	describeUserInputWait,
	isPermissionRequestActivity,
	type UserInputWaitSession,
} from "../../../src/terminal/user-input-wait";

const HOOK_AT = 1_000_000;

function activity(overrides: Partial<RuntimeTaskHookActivity>): RuntimeTaskHookActivity {
	return {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		hookEventName: null,
		notificationType: null,
		source: null,
		...overrides,
	};
}

function session(overrides: Partial<UserInputWaitSession>): UserInputWaitSession {
	return { state: "awaiting_review", reviewReason: "hook", lastHookAt: HOOK_AT, ...overrides };
}

describe("describeUserInputWait", () => {
	it("reads Claude Code's PermissionRequest hook as an approval, with what it asks", () => {
		const wait = describeUserInputWait(
			session({
				latestHookActivity: activity({
					hookEventName: "PermissionRequest",
					toolName: "Bash",
					activityText: "Waiting for approval: Bash: rm -rf node_modules",
				}),
			}),
		);
		expect(wait).toEqual({ kind: "approval", since: HOOK_AT, text: "Bash: rm -rf node_modules" });
	});

	it("reads a Notification permission_prompt as an approval, also while the session still runs (Copilot's hook)", () => {
		const notification = activity({
			hookEventName: "Notification",
			notificationType: "permission_prompt",
			activityText: "Waiting for approval: Claude needs your permission to use Bash",
		});
		expect(describeUserInputWait(session({ latestHookActivity: notification }))?.text).toBe(
			"Claude needs your permission to use Bash",
		);
		const copilot = activity({ hookEventName: "permissionRequest", activityText: "Waiting for approval" });
		expect(
			describeUserInputWait(session({ state: "running", reviewReason: null, latestHookActivity: copilot })),
		).toEqual({
			kind: "approval",
			since: HOOK_AT,
			text: "Permission request",
		});
	});

	it("never reads a notification type a later hook left behind (the summary merges hook fields)", () => {
		// PostToolUse after the approval: the merge kept notificationType from the Notification hook.
		const answered = activity({
			hookEventName: "PostToolUse",
			notificationType: "permission_prompt",
			toolName: "Bash",
		});
		expect(isPermissionRequestActivity(answered)).toBe(false);
		expect(
			describeUserInputWait(session({ state: "running", reviewReason: null, latestHookActivity: answered })),
		).toBe(null);
	});

	it("reads Claude Code's AskUserQuestion and Cline's ask tools as a question, also behind a permission request", () => {
		const ask = activity({
			hookEventName: "PreToolUse",
			toolName: "AskUserQuestion",
			activityText: "Using AskUserQuestion: Which database should the cards use?",
		});
		expect(describeUserInputWait(session({ state: "running", reviewReason: null, latestHookActivity: ask }))).toEqual(
			{
				kind: "question",
				since: HOOK_AT,
				text: "Which database should the cards use?",
			},
		);
		const askPermission = activity({
			hookEventName: "PermissionRequest",
			toolName: "AskUserQuestion",
			activityText: "Waiting for approval: AskUserQuestion: Ship it?",
		});
		expect(describeUserInputWait(session({ latestHookActivity: askPermission }))).toMatchObject({
			kind: "question",
			text: "Ship it?",
		});
		const cline = activity({
			hookEventName: "PreToolUse",
			toolName: "ask_followup_question",
			activityText: "Agent active",
		});
		expect(describeUserInputWait(session({ latestHookActivity: cline }))).toMatchObject({ kind: "question" });
		// The tool ran: PostToolUse is the newest hook and the session runs again.
		const done = activity({ hookEventName: "PostToolUse", toolName: "AskUserQuestion" });
		expect(describeUserInputWait(session({ state: "running", reviewReason: null, latestHookActivity: done }))).toBe(
			null,
		);
	});

	it("reads a turn that ended on a question as a question; any other turn end waits for nothing", () => {
		const stop = (finalMessage: string) =>
			session({ latestHookActivity: activity({ hookEventName: "Stop", finalMessage }) });
		expect(describeUserInputWait(stop("I moved the cards. Should I also land 4a1f2 now?"))).toEqual({
			kind: "question",
			since: HOOK_AT,
			text: "Should I also land 4a1f2 now?",
		});
		expect(describeUserInputWait(stop("Do you want **option A** or **option B?**"))?.kind).toBe("question");
		expect(describeUserInputWait(stop("Done: all three cards landed."))).toBe(null);
		expect(describeUserInputWait(stop("Is this right? I checked it and it is."))).toBe(null);
		// The same final message with a later tool hook (the merge kept it) is not a turn end.
		expect(
			describeUserInputWait(
				session({
					state: "running",
					reviewReason: null,
					latestHookActivity: activity({ hookEventName: "PreToolUse", toolName: "Bash", finalMessage: "Ready?" }),
				}),
			),
		).toBe(null);
	});

	it("clears when the user answered, the session ended or it stopped waiting", () => {
		const waiting = session({
			latestHookActivity: activity({ hookEventName: "PermissionRequest", toolName: "Bash" }),
		});
		expect(describeUserInputWait(waiting)).not.toBe(null);
		expect(describeUserInputWait(waiting, { answeredAt: HOOK_AT + 5 })).toBe(null);
		// An Enter before the request is no answer to it.
		expect(describeUserInputWait(waiting, { answeredAt: HOOK_AT - 5 })).not.toBe(null);
		for (const state of ["idle", "failed", "interrupted"] as const) {
			expect(describeUserInputWait({ ...waiting, state })).toBe(null);
		}
		expect(describeUserInputWait(null)).toBe(null);
		// A process exit in Review (reviewReason exit) after a question is no question either.
		expect(
			describeUserInputWait(
				session({
					reviewReason: "exit",
					latestHookActivity: activity({ hookEventName: "Stop", finalMessage: "Ok?" }),
				}),
			),
		).toBe(null);
	});
});
