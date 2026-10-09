import { describe, expect, it } from "vitest";

import { describeTurnEvidence, readCurrentEmptyDiff, readEmptyDiff } from "../../../src/pipeline/empty-diff";
import type { PipelineSessionView } from "../../../src/pipeline/engine";

function session(overrides: Partial<PipelineSessionView>): PipelineSessionView {
	return { taskId: "t", agentId: "claude", modelId: null, state: "awaiting_review", ...overrides };
}

const activity = (overrides: Partial<NonNullable<PipelineSessionView["latestHookActivity"]>>) => ({
	activityText: null,
	toolName: null,
	toolInputSummary: null,
	finalMessage: null,
	hookEventName: null,
	notificationType: null,
	source: null,
	...overrides,
});

describe("describeTurnEvidence", () => {
	it("counts a turn end through a hook, a final message or a hook of this run as a turn", () => {
		expect(describeTurnEvidence(session({ reviewReason: "hook" })).ran).toBe(true);
		expect(
			describeTurnEvidence(
				session({ reviewReason: "exit", latestHookActivity: activity({ finalMessage: "Done." }) }),
			),
		).toEqual({ ran: true, evidence: "the agent sent a final message" });
		expect(
			describeTurnEvidence(
				session({
					startedAt: 100,
					lastHookAt: 200,
					latestHookActivity: activity({ hookEventName: "PostToolUse" }),
				}),
			).evidence,
		).toContain("PostToolUse at");
	});

	it("never ran: no session, or no hook since this run started (PTY output doesn't count)", () => {
		expect(describeTurnEvidence(null)).toEqual({ ran: false, evidence: "no session" });
		const before = describeTurnEvidence(
			session({ reviewReason: "exit", startedAt: 200, lastHookAt: 100, lastOutputAt: 300 }),
		);
		expect(before).toEqual({
			ran: false,
			evidence: "no hook or final message from this run (session awaiting_review, reviewReason exit)",
		});
	});
});

describe("readEmptyDiff", () => {
	const record = {
		at: "2026-10-09T04:44:58.000Z",
		cardUpdatedAt: 7,
		snapshot: "abc",
		parent: "def",
		baseRef: "main",
		ran: true,
		evidence: "x",
	};

	it("reads a record and only counts it for the card's current submission", () => {
		expect(readEmptyDiff({ emptyDiff: record })).toEqual(record);
		expect(readEmptyDiff({ emptyDiff: { at: "x" } })).toBeNull();
		expect(readEmptyDiff(undefined)).toBeNull();
		expect(readCurrentEmptyDiff({ emptyDiff: record }, { updatedAt: 7 })).toEqual(record);
		expect(readCurrentEmptyDiff({ emptyDiff: record }, { updatedAt: 8 })).toBeNull();
	});
});
