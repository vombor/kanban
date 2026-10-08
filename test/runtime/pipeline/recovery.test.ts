import { describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import type { PipelineSessionView } from "../../../src/pipeline/engine";
import {
	applyOutageProbe,
	decideRecovery,
	isOrphanMarkStale,
	leftReviewPatch,
	type RecoveryCardInput,
	type RecoveryDecision,
	readRecoveryFlow,
	recoveryRedoReason,
	sinceBudget,
} from "../../../src/pipeline/recovery";
import { CONTINUE_PROMPT } from "../../../src/pipeline/recovery-prompts";
import type { ClineSessionDetail, ClineSessionDetailMessage } from "../../../src/terminal/cline-session-files";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const MIN = 60_000;
const settings = parsePipelineConfig({}).config.pipeline.recovery;
const CLINE_PROFILE = { clearContextCommand: "/clear", cancelTurnInput: "\u001b" };

const card: RuntimeBoardCard = {
	id: "dev1",
	title: "Do the thing",
	prompt: "Implement the thing.",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 0,
	updatedAt: 0,
} as RuntimeBoardCard;

function message(
	role: string,
	value: string,
	extra: Partial<ClineSessionDetailMessage> = {},
): ClineSessionDetailMessage {
	return { role, content: [{ type: "text", text: value }], outputTokens: null, ts: null, ...extra };
}

function detail(
	messages: ClineSessionDetailMessage[],
	options: { status?: string; writtenAgoMs?: number } = {},
): ClineSessionDetail {
	const writtenAt = NOW - (options.writtenAgoMs ?? 10 * MIN);
	const last = messages.at(-1) ?? null;
	return {
		snapshot: {
			sessionId: "1700_abc",
			status: options.status ?? "idle",
			startedAt: NOW - 60 * MIN,
			messagesWrittenAt: writtenAt,
			lastMessage: last ? { role: last.role, content: last.content } : null,
		},
		messages,
		lastWriteAt: writtenAt,
	};
}

const session = (overrides: Partial<PipelineSessionView> = {}): PipelineSessionView => ({
	taskId: "dev1",
	agentId: "cline",
	modelId: null,
	state: "awaiting_review",
	reviewReason: "hook",
	live: true,
	...overrides,
});

function input(overrides: Partial<RecoveryCardInput> = {}): RecoveryCardInput {
	return {
		card,
		column: "review",
		role: "dev",
		model: { provider: "bedrock", model: "us.moonshot.kimi-k3" },
		session: session(),
		detail: detail([message("user", "go"), message("assistant", "Finished. STATUS: DONE")]),
		readsTurnOutcome: true,
		profile: CLINE_PROFILE,
		flow: readRecoveryFlow(undefined),
		canProbe: true,
		capacityHold: null,
		slowFirstCall: false,
		continuesPrematureStops: true,
		settings,
		now: NOW,
		...overrides,
	};
}

function flow(qaflow: Record<string, unknown>) {
	return readRecoveryFlow({ qaflow });
}

function expectKind<K extends RecoveryDecision["kind"]>(
	decision: RecoveryDecision,
	kind: K,
): Extract<RecoveryDecision, { kind: K }> {
	expect(decision.kind, JSON.stringify(decision)).toBe(kind);
	return decision as Extract<RecoveryDecision, { kind: K }>;
}

const providerError = (text = "503 Service Unavailable") => detail([message("user", "go"), message("assistant", text)]);

describe("decideRecovery: Review cards", () => {
	it("leaves a finished turn (STATUS: DONE) alone", () => {
		expectKind(decideRecovery(input()), "none");
	});

	it("holds a card whose session is still working (c5c42ec false flip), and records the hold", () => {
		const decision = expectKind(
			decideRecovery(
				input({
					session: session({ state: "running" }),
					detail: detail([message("user", "go")], { status: "running", writtenAgoMs: 30_000 }),
				}),
			),
			"wait",
		);
		expect(decision.patch).toEqual({ liveHold: "1700_abc" });
	});

	it("escalates a BLOCKED or NEEDS_INPUT status line (ebde195)", () => {
		const decision = expectKind(
			decideRecovery(input({ detail: detail([message("assistant", "Need a key.\nSTATUS: NEEDS_INPUT: API key")]) })),
			"escalate",
		);
		expect(decision.reason).toBe("agent reported NEEDS_INPUT: API key");
		expect(decision.patch.escalated).toEqual({ at: new Date(NOW).toISOString(), reason: decision.reason });
	});

	it("schedules backoff retries for a provider error, outside the nudge budget (daf86a5)", () => {
		const first = expectKind(decideRecovery(input({ detail: providerError() })), "hold");
		expect(first.patch.retryAt).toBe(new Date(NOW + 1 * MIN).toISOString());
		expect(first.patch.transient).toHaveLength(1);
		const third = expectKind(
			decideRecovery(
				input({
					detail: providerError(),
					flow: flow({
						transient: [
							{ at: "2026-10-07T11:00:00.000Z", warn: "503" },
							{ at: "2026-10-07T11:10:00.000Z", warn: "503" },
						],
					}),
				}),
			),
			"hold",
		);
		expect(third.patch.retryAt).toBe(new Date(NOW + 4 * MIN).toISOString());
	});

	it("holds for an outage once the retries are used up, if the provider has a probe (692f174)", () => {
		const usedUp = flow({
			transient: [1, 2, 3, 4].map((n) => ({ at: `2026-10-07T11:0${n}:00.000Z`, warn: "503" })),
		});
		const hold = expectKind(decideRecovery(input({ detail: providerError(), flow: usedUp })), "hold");
		expect(hold.patch.outage).toMatchObject({ model: "bedrock/us.moonshot.kimi-k3", ups: 0, lastProbe: null });
		// No probe for this provider: it falls through to a crash nudge.
		const nudge = expectKind(
			decideRecovery(input({ detail: providerError(), flow: usedUp, canProbe: false })),
			"nudge",
		);
		expect(nudge.cause).toBe("crash");
	});

	it("sends the due retry, and waits for one that is not due yet", () => {
		const due = expectKind(
			decideRecovery(
				input({
					flow: flow({
						retryAt: new Date(NOW - 1000).toISOString(),
						transient: [{ at: "2026-10-07T11:59:00.000Z", warn: "503 Service Unavailable" }],
					}),
				}),
			),
			"nudge",
		);
		expect(due.cause).toBe("retry");
		expect(due.text).toContain("provider error (503 Service Unavailable)");
		expect(due.patch).toEqual({ retryAt: null });
		expectKind(decideRecovery(input({ flow: flow({ retryAt: new Date(NOW + MIN).toISOString() }) })), "wait");
	});

	it("probes during an outage hold and escalates after maxMin", () => {
		const outage = {
			since: new Date(NOW - 20 * MIN).toISOString(),
			model: "m",
			warn: "503",
			ups: 0,
			lastProbe: null,
		};
		expectKind(decideRecovery(input({ flow: flow({ outage }) })), "probe");
		const recent = { ...outage, lastProbe: new Date(NOW - MIN).toISOString() };
		expectKind(decideRecovery(input({ flow: flow({ outage: recent }) })), "wait");
		const old = { ...outage, since: new Date(NOW - 361 * MIN).toISOString() };
		const escalated = expectKind(decideRecovery(input({ flow: flow({ outage: old }) })), "escalate");
		expect(escalated.patch.outage).toBeNull();
	});

	it("resumes after upsToResume good probes in a row; a bad probe resets the count", () => {
		const outage = {
			since: new Date(NOW - 30 * MIN).toISOString(),
			model: "m",
			warn: "503",
			ups: 0,
			lastProbe: null,
		};
		const once = applyOutageProbe(flow({ outage }), true, settings, NOW);
		expect(once.resumed).toBe(false);
		expect(once.patch.outage).toMatchObject({ ups: 1 });
		const twice = applyOutageProbe(flow({ outage: { ...outage, ups: 1 } }), true, settings, NOW);
		expect(twice.resumed).toBe(true);
		expect(twice.patch).toMatchObject({ outage: null, retryAt: new Date(NOW).toISOString() });
		expect(
			applyOutageProbe(flow({ outage: { ...outage, ups: 1 } }), false, settings, NOW).patch.outage,
		).toMatchObject({
			ups: 0,
		});
	});

	it("clears a poisoned history and resends the card prompt (c09cd4b), naming an overflow's culprit", () => {
		const overflow = detail([
			message("user", "go"),
			{
				role: "user",
				content: [{ type: "tool_result", size: 300_000, query: "ls -R" }],
				outputTokens: null,
				ts: null,
			},
			message("assistant", "Error: prompt is too long: 140000 tokens > 131072"),
		]);
		const nudge = expectKind(
			decideRecovery(input({ session: session({ reviewReason: "error" }), detail: overflow })),
			"nudge",
		);
		expect(nudge).toMatchObject({ cause: "poisoned", clear: "/clear" });
		expect(nudge.overflow?.culprit).toEqual({ size: 300_000, query: "ls -R" });
		expect(nudge.text.startsWith("Implement the thing.")).toBe(true);
		expect(nudge.text).toContain("was cleared");
		// An agent with no clear command can't recover from it: escalate.
		expectKind(
			decideRecovery(input({ detail: overflow, profile: { clearContextCommand: null, cancelTurnInput: null } })),
			"escalate",
		);
	});

	it("nudges a crash up to maxNudges, then escalates", () => {
		const crashed = input({
			session: session({ reviewReason: "error" }),
			detail: detail([message("assistant", "Working…")], {}),
		});
		const nudge = expectKind(decideRecovery(crashed), "nudge");
		expect(nudge.cause).toBe("crash");
		expect(nudge.clear).toBeNull();
		const spent = flow({
			nudges: [
				{ at: "2026-10-07T11:00:00.000Z", reason: "error", poisoned: false, warn: "" },
				{ at: "2026-10-07T11:10:00.000Z", reason: "error", poisoned: false, warn: "" },
			],
		});
		expectKind(decideRecovery({ ...crashed, flow: spent }), "escalate");
		// A handback restarts the budget (158817d).
		expectKind(
			decideRecovery({
				...crashed,
				flow: readRecoveryFlow({
					qaflow: { ...spent, handbacks: [{ at: "2026-10-07T11:30:00.000Z" }] },
				}),
			}),
			"nudge",
		);
	});

	it("types nothing into a Review that hasn't settled, but still recovers a running summary that isn't working", () => {
		const premature = detail([message("user", "go"), message("assistant", "I'll now run the tests.")]);
		const justStopped = input({ session: session({ stateChangedAt: NOW - 5_000 }), detail: premature });
		expect(expectKind(decideRecovery(justStopped), "wait").reason).toContain("settle");
		expectKind(decideRecovery({ ...justStopped, now: NOW + 7_000 }), "nudge");
		expectKind(decideRecovery({ ...justStopped, reviewSettleMs: 5_000 }), "nudge");
		// A "running" summary in Review whose process is gone is recovery's to act on, not a turn that may resume.
		const lost = input({ session: session({ state: "running", live: false, stateChangedAt: NOW - 1_000 }) });
		expect(decideRecovery(lost).reason ?? "").not.toContain("settle");
	});

	it("continues a premature stop; an empty reply gets /clear + the prompt (bd4eeff)", () => {
		const announced = expectKind(
			decideRecovery(input({ detail: detail([message("assistant", "Now I'll update the tests:")]) })),
			"nudge",
		);
		expect(announced).toMatchObject({ cause: "premature", clear: null });
		const empty = expectKind(
			decideRecovery(input({ detail: detail([message("assistant", "", { outputTokens: 4096 })]) })),
			"nudge",
		);
		expect(empty.clear).toBe("/clear");
		expect(empty.text).toContain("4096-token output limit");
		const spent = flow({
			continues: Array.from({ length: 8 }, (_, n) => ({ at: `2026-10-07T11:${10 + n}:00.000Z`, said: "x" })),
		});
		expectKind(
			decideRecovery(input({ flow: spent, detail: detail([message("assistant", "Let me check:")]) })),
			"escalate",
		);
	});

	it("waits while the provider is at its loaded-model limit", () => {
		const decision = expectKind(
			decideRecovery(
				input({
					detail: detail([message("assistant", "Let me check:")]),
					capacityHold: { provider: "lemonade", maxLoadedModels: 1, holders: ["other (glm)"] },
				}),
			),
			"wait",
		);
		expect(decision.reason).toContain("other (glm)");
	});

	it("waits nudgeCheckSec after a message before deciding again (an unconfirmed nudge)", () => {
		expectKind(
			decideRecovery(
				input({
					detail: detail([message("assistant", "Let me check:")]),
					flow: flow({ recoverySentAt: new Date(NOW - 30_000).toISOString() }),
				}),
			),
			"wait",
		);
	});

	it("never touches non-dev, escalated or orphaned cards, or agents without readable turns", () => {
		const premature = { detail: detail([message("assistant", "Let me check:")]) };
		expectKind(decideRecovery(input({ ...premature, role: "qa" })), "none");
		expectKind(decideRecovery(input({ ...premature, role: "calibration" })), "none");
		expectKind(decideRecovery(input({ ...premature, flow: flow({ escalated: { at: "x", reason: "y" } }) })), "none");
		expectKind(
			decideRecovery(input({ ...premature, flow: flow({ orphan: { at: "x", kanbanStart: "y", kind: "dev" } }) })),
			"none",
		);
		expectKind(decideRecovery(input({ ...premature, readsTurnOutcome: false, detail: null })), "none");
		expectKind(decideRecovery(input({ ...premature, session: session({ live: false }) })), "none");
	});
});

describe("decideRecovery: In Progress cards (hung requests, 0261b20)", () => {
	const hung = detail([message("user", "go")], { status: "running", writtenAgoMs: 20 * MIN });
	const running = session({ state: "running", reviewReason: null });

	it("cancels a hung request with the adapter's cancel input and schedules the retry", () => {
		const decision = expectKind(
			decideRecovery(input({ column: "in_progress", session: running, detail: hung })),
			"cancel_hung",
		);
		expect(decision.input).toBe("\u001b");
		expect(decision.patch.hung).toMatchObject({ dir: "1700_abc" });
		expect(decision.followUp).toMatchObject({ kind: "hold" });
		// The same hang is cancelled once.
		expectKind(
			decideRecovery(
				input({
					column: "in_progress",
					session: running,
					detail: hung,
					flow: flow({ hung: { dir: "1700_abc", lastWrite: hung.lastWriteAt, at: "x" } }),
				}),
			),
			"none",
		);
	});

	it("sends a due retry on a cancelled card that stayed In Progress", () => {
		const decision = expectKind(
			decideRecovery(
				input({
					column: "in_progress",
					session: running,
					detail: hung,
					flow: flow({ retryAt: new Date(NOW - 1).toISOString(), transient: [{ at: "x", warn: "hung" }] }),
				}),
			),
			"nudge",
		);
		expect(decision.cause).toBe("retry");
	});

	it("without a cancel input, a silent request gets the silent-stall continue instead of an Esc", () => {
		const decision = expectKind(
			decideRecovery(
				input({
					column: "in_progress",
					session: running,
					detail: hung,
					profile: { clearContextCommand: "/clear", cancelTurnInput: null },
				}),
			),
			"nudge",
		);
		expect(decision).toMatchObject({ cause: "silent_stall", text: CONTINUE_PROMPT });
	});
});

describe("recovery state", () => {
	it("holds a turn recovery resent until the session shows activity after it or nudgeCheckSec passes", () => {
		const sentAt = NOW - MIN;
		const entry = { qaflow: { recoverySentAt: new Date(sentAt).toISOString() } };
		const checkMs = settings.nudgeCheckSec * 1000;
		const review = (stateChangedAt: number) => ({ state: "awaiting_review" as const, stateChangedAt });

		expect(recoveryRedoReason(entry, review(sentAt - MIN), NOW, checkMs)).toContain("recovery resent the turn");
		// A summary without the settle clock, or none at all, is held by time alone.
		expect(recoveryRedoReason(entry, { state: "awaiting_review" }, NOW, checkMs)).not.toBeNull();
		expect(recoveryRedoReason(entry, null, NOW, checkMs)).not.toBeNull();
		// The redone turn ended after the send: its Review is new work.
		expect(recoveryRedoReason(entry, review(sentAt + 1000), NOW, checkMs)).toBeNull();
		// After nudgeCheckSec recovery decides on the card again.
		expect(recoveryRedoReason(entry, review(sentAt - MIN), sentAt + checkMs, checkMs)).toBeNull();
		expect(recoveryRedoReason({}, review(sentAt - MIN), NOW, checkMs)).toBeNull();
	});

	it("counts budgets from the newest verdict, handback or fresh restart", () => {
		const state = flow({
			resetAt: "2026-10-07T11:00:00.000Z",
			nudges: [{ at: "2026-10-07T10:00:00.000Z" }, { at: "2026-10-07T11:30:00.000Z" }],
		});
		expect(sinceBudget(state.nudges, state).map((entry) => entry.at)).toEqual(["2026-10-07T11:30:00.000Z"]);
	});

	it("ends a retry, an outage hold and a live hold when the card leaves Review by hand", () => {
		const outage = { since: "2026-10-07T11:00:00.000Z", model: "m", warn: "503", ups: 0, lastProbe: null };
		const patch = leftReviewPatch(flow({ retryAt: "x", outage, liveHold: "d" }), NOW);
		expect(patch).toMatchObject({ retryAt: null, outage: null, liveHold: null });
		expect(patch.outages).toEqual([{ ...outage, ended: new Date(NOW).toISOString(), result: "card moved by hand" }]);
		expect(leftReviewPatch(flow({}), NOW)).toEqual({});
	});

	it("restarts the budgets at the newest QA verdict the QA gate recorded (qaVerdicts[].at)", () => {
		const nudges = [
			{ at: "2026-10-07T11:00:00.000Z", reason: "error", poisoned: false, warn: "" },
			{ at: "2026-10-07T11:10:00.000Z", reason: "error", poisoned: false, warn: "" },
		];
		const crashed = input({
			session: session({ reviewReason: "error" }),
			detail: detail([message("assistant", "Working…")]),
		});
		expectKind(decideRecovery({ ...crashed, flow: flow({ nudges }) }), "escalate");
		// A FAIL verdict ingested after those nudges, then a rework: the card gets its nudges again.
		const afterVerdict = readRecoveryFlow({
			qaflow: { nudges },
			qaVerdicts: [{ at: Date.parse("2026-10-07T11:20:00.000Z") }],
		});
		expect(afterVerdict.lastVerdictAt).toBe("2026-10-07T11:20:00.000Z");
		expectKind(decideRecovery({ ...crashed, flow: afterVerdict }), "nudge");
	});

	it("restarts the budgets at a rework, and leaves a fresh rework that hasn't started to the rework stage", () => {
		const nudges = [
			{ at: "2026-10-07T11:00:00.000Z", reason: "error", poisoned: false, warn: "" },
			{ at: "2026-10-07T11:10:00.000Z", reason: "error", poisoned: false, warn: "" },
		];
		const crashed = input({
			session: session({ reviewReason: "error" }),
			detail: detail([message("assistant", "Working…")]),
		});
		const reworkAt = new Date(NOW - 60_000).toISOString();
		const sent = flow({ nudges, lastReworkAt: reworkAt, reworks: [{ at: reworkAt, via: "chat" }] });
		expect(sent.lastReworkAt).toBe(reworkAt);
		expect(sinceBudget(sent.nudges, sent)).toEqual([]);
		// Sent a minute ago and not seen started: the started-check's card.
		expect(expectKind(decideRecovery({ ...crashed, flow: sent }), "none").reason).toContain(
			"the rework stage's started-check owns it",
		);
		// Not restarted yet, however old (a slow or stopped worker runs the started-check late): still its card.
		const old = new Date(NOW - 60 * MIN).toISOString();
		expectKind(decideRecovery({ ...crashed, flow: flow({ lastReworkAt: old, reworks: [{ at: old }] }) }), "none");
		// Started, returned, closed, or restarted more than one started-check window ago: recovery's again.
		for (const rework of [
			{ at: reworkAt, startedAt: reworkAt },
			{ at: reworkAt, returned: reworkAt },
			{ at: reworkAt, closedBy: "handback" },
			{ at: new Date(NOW - 5 * MIN).toISOString(), restartAt: new Date(NOW - 3 * MIN).toISOString() },
		]) {
			expectKind(
				decideRecovery({ ...crashed, flow: flow({ lastReworkAt: rework.at, reworks: [rework] }) }),
				"nudge",
			);
		}
	});

	it("reads an orphan mark as stale once the card has a session again or the mark is from another start", () => {
		const start = Date.parse("2026-10-07T11:00:00.000Z");
		const marked = flow({ orphan: { at: "x", kanbanStart: new Date(start).toISOString(), kind: "dev" } });
		expect(isOrphanMarkStale(marked, { live: false, startedAt: start - 1 }, start)).toBe(false);
		expect(isOrphanMarkStale(marked, { live: true, startedAt: start - 1 }, start)).toBe(true);
		expect(isOrphanMarkStale(marked, { live: false, startedAt: start + 1 }, start)).toBe(true);
		expect(isOrphanMarkStale(marked, { live: false, startedAt: start - 1 }, start + 60_000)).toBe(true);
		expect(leftReviewPatch(marked, NOW)).toEqual({ orphan: null });
	});

	it("skips premature-stop continues where they are off, and keeps the hung note stable over time", () => {
		const announced = input({ detail: detail([message("assistant", "Now I'll update the tests:")]) });
		expectKind(decideRecovery({ ...announced, continuesPrematureStops: false }), "none");
		const hung = detail([message("user", "go")], { status: "running", writtenAgoMs: 20 * MIN });
		const running = session({ state: "running", reviewReason: null });
		const at = (now: number) =>
			expectKind(
				decideRecovery(input({ column: "in_progress", session: running, detail: hung, now })),
				"cancel_hung",
			).reason;
		expect(at(NOW)).toBe(at(NOW + 5 * MIN));
	});
});
