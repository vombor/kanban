import { describe, expect, it } from "vitest";

import type { RuntimeTaskHookActivity } from "../../../src/core/api-contract";
import { isTurnEndHookEvent, readTurnFinalMessage } from "../../../src/core/turn-final-message";

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

describe("readTurnFinalMessage", () => {
	it("reads the final message of a turn that ended through a hook", () => {
		for (const hookEventName of ["Stop", "TaskComplete", "agentStop", "agent_end", "AfterAgent", null]) {
			expect(
				readTurnFinalMessage({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: activity({ finalMessage: "  Done.  ", hookEventName }),
				}),
			).toBe("Done.");
		}
	});

	it("ignores a final message left over under a later hook", () => {
		expect(
			readTurnFinalMessage({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: activity({ finalMessage: "Old turn.", hookEventName: "PreToolUse" }),
			}),
		).toBeNull();
	});

	it("needs a turn end in Review", () => {
		const latestHookActivity = activity({ finalMessage: "Done.", hookEventName: "Stop" });
		expect(readTurnFinalMessage({ state: "running", reviewReason: "hook", latestHookActivity })).toBeNull();
		expect(readTurnFinalMessage({ state: "awaiting_review", reviewReason: "exit", latestHookActivity })).toBeNull();
		expect(
			readTurnFinalMessage({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: activity({ finalMessage: "   ", hookEventName: "Stop" }),
			}),
		).toBeNull();
		expect(readTurnFinalMessage(null)).toBeNull();
	});

	it("knows the turn-end hook events", () => {
		expect(isTurnEndHookEvent(" Stop ")).toBe(true);
		expect(isTurnEndHookEvent(undefined)).toBe(true);
		expect(isTurnEndHookEvent("UserPromptSubmit")).toBe(false);
	});
});
