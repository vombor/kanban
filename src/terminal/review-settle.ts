// The review settle rule: when a session's Review counts as "the turn is over" for code that acts on finished work.
//
// Session sync moves a card to Review the moment its summary says awaiting_review, and that move stays immediate:
// it is what the user sees. But some turns end and resume right away. Copilot with --autopilot fires its agentStop
// hook on every autopilot continuation and its own continue prompt fires userPromptSubmitted about 100 ms later;
// a background shell that finishes after the final agentStop starts a new turn about 6 s later (the autopilot
// trial, ec0f616). Any agent whose turn ends and resumes quickly does the same. Code that treats Review as
// "finished" and acts in that window snapshots half-done work and queues QA on it, or types auto-review's commit
// prompt into a working agent (whose card then sticks in Review).
//
// So those consumers act only on a settled Review: the session has been awaiting_review, with no new state change
// or hook activity, for `sessionSync.reviewSettleSec` (src/config/pipeline-config.ts). They are the pipeline's
// submission stage and QA gate (engine.ts, qa-gate.ts: snapshot, queue, ingest, land a PASS), the rework stage's
// "returned" check and new reworks (rework.ts), recovery's Review decisions (recovery.ts) and the auto-review
// reconciler (src/server/auto-review-reconciler.ts). A new consumer of that kind uses isReviewSettled() too,
// rather than a delay of its own.
//
// The clock is the summary's `stateChangedAt` (written by the session manager on every state change), the session
// start and `lastHookAt`, whichever is newest. Terminal output doesn't count: an idle TUI repaints. A summary
// without `stateChangedAt` (written by a build before this rule, or hydrated from one) is settled: nothing about
// it can still resume. No summary, or any state but running and awaiting_review, is settled; running never is.
import { DEFAULT_REVIEW_SETTLE_SEC } from "../config/pipeline-config";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";

/** `sessionSync.reviewSettleSec` by default (the 12 s are justified there). */
export const DEFAULT_REVIEW_SETTLE_MS = DEFAULT_REVIEW_SETTLE_SEC * 1000;

export type ReviewSettleSession = Pick<RuntimeTaskSessionSummary, "state"> &
	Partial<Pick<RuntimeTaskSessionSummary, "stateChangedAt" | "startedAt" | "lastHookAt">>;

/** When the session last showed activity in its current Review, or null when the rule has nothing to wait for. */
export function getReviewActivityAt(session: ReviewSettleSession | null | undefined): number | null {
	if (!session || session.state !== "awaiting_review" || typeof session.stateChangedAt !== "number") {
		return null;
	}
	return Math.max(session.stateChangedAt, session.startedAt ?? 0, session.lastHookAt ?? 0);
}

/** Whether a consumer may treat this session's Review as a finished turn (see the rule above). */
export function isReviewSettled(
	session: ReviewSettleSession | null | undefined,
	now: number,
	settleMs: number = DEFAULT_REVIEW_SETTLE_MS,
): boolean {
	if (session?.state === "running") {
		return false;
	}
	const activityAt = getReviewActivityAt(session);
	return activityAt === null || now - activityAt >= settleMs;
}
