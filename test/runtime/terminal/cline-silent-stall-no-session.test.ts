import { describe, expect, it } from "vitest";

import type { ClineSessionDetail } from "../../../src/terminal/cline-session-files";
import {
	CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS,
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

describe("Cline silent stall: a model the provider is still loading (kanban models vet, 2026-10-09)", () => {
	const prompt = { role: "user", content: [{ type: "text", text: "go" }], outputTokens: null, ts: RUN + 5_000 };
	const waiting: ClineSessionDetail = { ...detail(RUN, RUN + 5_000), messages: [prompt] };

	it("gives the first reply the load allowance, and no stall while the model loads", () => {
		const now = RUN + 5_000 + 12 * MIN;
		expect(evaluateClineSilentStall({ detail: waiting, kanbanProgressAt: RUN, now })?.idleMs).toBe(12 * MIN);
		expect(
			evaluateClineSilentStall({
				detail: waiting,
				kanbanProgressAt: RUN,
				firstReplyAllowanceMs: CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS,
				now,
			})?.idleMs,
		).toBe(2 * MIN);
		expect(evaluateClineSilentStall({ detail: waiting, kanbanProgressAt: RUN, modelLoading: true, now })).toBeNull();
	});

	it("gives no allowance once the model has replied", () => {
		const reply = { role: "assistant", content: [{ type: "text", text: "on it" }], outputTokens: 3, ts: RUN + MIN };
		const later = { ...prompt, ts: RUN + 2 * MIN };
		const replied: ClineSessionDetail = { ...detail(RUN, RUN + 2 * MIN), messages: [prompt, reply, later] };
		const stall = evaluateClineSilentStall({
			detail: replied,
			kanbanProgressAt: RUN,
			firstReplyAllowanceMs: CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS,
			now: RUN + 12 * MIN,
		});
		expect(stall).toMatchObject({ kind: "untouched", idleMs: 10 * MIN });
	});
});
