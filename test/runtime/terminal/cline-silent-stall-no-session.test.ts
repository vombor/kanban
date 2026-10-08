import { describe, expect, it } from "vitest";

import type { ClineSessionDetail } from "../../../src/terminal/cline-session-files";
import {
	describeClineSilentStall,
	evaluateClineSilentStall,
	isClineSessionOfRun,
} from "../../../src/terminal/cline-turn-check";

const MIN = 60_000;
const RUN = Date.parse("2026-10-08T04:45:51.000Z");

function detail(startedAt: number, writtenAt: number): ClineSessionDetail {
	return {
		snapshot: { sessionId: "s1", status: "idle", startedAt, messagesWrittenAt: writtenAt, lastMessage: null },
		messages: [],
		lastWriteAt: writtenAt,
	};
}

describe("Cline silent stall: a run with no session file of its own (issue #9)", () => {
	it("counts a session as the run's when it started then or later, or was written since", () => {
		expect(isClineSessionOfRun(null, RUN)).toBe(false);
		expect(isClineSessionOfRun(detail(RUN + 1_000, RUN + 1_000), RUN)).toBe(true);
		expect(isClineSessionOfRun(detail(RUN - 60 * MIN, RUN - 30 * MIN), RUN)).toBe(false);
		expect(isClineSessionOfRun(detail(RUN - 60 * MIN, RUN + MIN), RUN)).toBe(true);
		expect(isClineSessionOfRun(detail(RUN - 60 * MIN, RUN - 30 * MIN), null)).toBe(true);
	});

	it("is a no_session stall from the run's start, and only when the run's start is known", () => {
		const now = RUN + 9 * MIN;
		expect(evaluateClineSilentStall({ detail: null, kanbanProgressAt: RUN, now })).toBeNull();
		const stall = evaluateClineSilentStall({ detail: null, kanbanProgressAt: RUN, runStartedAt: RUN, now });
		expect(stall).toMatchObject({ kind: "no_session", sessionId: null, lastProgressAt: RUN, idleMs: 9 * MIN });
		expect(describeClineSilentStall(stall as NonNullable<typeof stall>)).toBe(
			"Cline never took the prompt: no Cline session file since 2026-10-08T04:45:51.000Z (a sign-in or setup screen in its TUI?)",
		);
		expect(
			describeClineSilentStall({
				...(stall as NonNullable<typeof stall>),
				signInGap: "providers.json stores no Bedrock key (Cline's TUI doesn't count AWS_BEARER_TOKEN_BEDROCK)",
			}),
		).toBe(
			"Cline is asking for sign-in: no Cline session file since 2026-10-08T04:45:51.000Z, and providers.json stores no Bedrock key (Cline's TUI doesn't count AWS_BEARER_TOKEN_BEDROCK) (kanban doctor)",
		);
		// A hook after the start restarts the clock.
		expect(
			evaluateClineSilentStall({ detail: null, kanbanProgressAt: RUN + 5 * MIN, runStartedAt: RUN, now })?.idleMs,
		).toBe(4 * MIN);
	});
});
