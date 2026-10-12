import { describe, expect, it } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { readTurnEnd, readTurnFinalMessage } from "../../../src/core/turn-final-message";

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

// A whole summary slice, as callers pass it (the reader looks at more than its own type names).
type SummarySlice = Pick<RuntimeTaskSessionSummary, "state"> & Partial<RuntimeTaskSessionSummary>;
const slice = (session: SummarySlice): SummarySlice => session;

describe("readTurnFinalMessage", () => {
	it("reads the turn end the session is in Review for", () => {
		const session = {
			state: "awaiting_review" as const,
			reviewReason: "hook" as const,
			lastTurnEnd: { at: 10, finalMessage: "  Done.  " },
		};
		expect(readTurnFinalMessage(session)).toBe("Done.");
		expect(readTurnEnd(session)).toEqual({ at: 10, finalMessage: "Done." });
	});

	it("still reads it when a later hook (Claude's idle Notification after Stop) is the newest event", () => {
		expect(
			readTurnFinalMessage(
				slice({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: activity({
						finalMessage: "Done.",
						hookEventName: "Notification",
						notificationType: "idle_prompt",
					}),
					lastTurnEnd: { at: 10, finalMessage: "Done." },
				}),
			),
		).toBe("Done.");
	});

	it("never reads a final message the hook activity carries without a recorded turn end", () => {
		expect(
			readTurnFinalMessage(
				slice({
					state: "awaiting_review",
					reviewReason: "hook",
					latestHookActivity: activity({ finalMessage: "Old turn.", hookEventName: "Stop" }),
					lastTurnEnd: null,
				}),
			),
		).toBeNull();
	});

	it("needs a turn end in Review through a hook", () => {
		const lastTurnEnd = { at: 10, finalMessage: "Done." };
		expect(readTurnFinalMessage({ state: "running", reviewReason: "hook", lastTurnEnd })).toBeNull();
		expect(readTurnFinalMessage({ state: "awaiting_review", reviewReason: "exit", lastTurnEnd })).toBeNull();
		expect(
			readTurnFinalMessage({
				state: "awaiting_review",
				reviewReason: "hook",
				lastTurnEnd: { at: 10, finalMessage: "   " },
			}),
		).toBeNull();
		expect(readTurnFinalMessage(null)).toBeNull();
	});
});
