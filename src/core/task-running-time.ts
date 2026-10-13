// How long a card's agent has worked (user request 2026-10-12: "1.2M↓ 48k↑ · 12m" on the board card). It is the time the
// card's session summary spent in `running`, summed over every turn of every run: Review, idle and interrupted time
// don't count, nor does the time a card waited in Backlog. Kanban kept no such total before (the summary only knew
// when its current state began, task-history.jsonl only logs Done and delete), so the session manager's updateSummary
// adds each finished `running` span to the summary's `runningMs`, and readers add the live span themselves.
import type { RuntimeTaskSessionSummary } from "./api-contract";

export type TaskRunningTimeSummary = Pick<
	RuntimeTaskSessionSummary,
	"state" | "startedAt" | "stateChangedAt" | "updatedAt" | "runningMs" | "runCount" | "firstRunStartedAt"
>;

export interface TaskRunningTime {
	/** Running time up to `now`, the live span included. */
	totalMs: number;
	/** When the live `running` span began; null when the agent isn't running. */
	runningSince: number | null;
	/** Agent sessions started for the card (0 on a summary from before Kanban counted them). */
	runCount: number;
	firstRunStartedAt: number | null;
}

/** When the summary's current `running` span began: its last state change, or its start if that came later. */
function getRunningSince(summary: TaskRunningTimeSummary): number | null {
	if (summary.state !== "running") {
		return null;
	}
	const changedAt = summary.stateChangedAt ?? null;
	const startedAt = summary.startedAt ?? null;
	if (changedAt === null || startedAt === null) {
		return changedAt ?? startedAt;
	}
	return Math.max(changedAt, startedAt);
}

/**
 * The summary fields after a patch (session-manager.ts's updateSummary): a `running` span that the patch ends (a state
 * change, or a new run's start) adds its length to `runningMs`. It ends at `at` for a session with a process, else at
 * the summary's last update: a summary hydrated as `running` from a stopped server must not count the downtime.
 */
export function accumulateRunningTime(
	previous: TaskRunningTimeSummary,
	patch: Partial<TaskRunningTimeSummary>,
	at: number,
	options: { live: boolean },
): Pick<RuntimeTaskSessionSummary, "runningMs"> | null {
	const since = getRunningSince(previous);
	if (since === null) {
		return null;
	}
	const stateChanged = patch.state !== undefined && patch.state !== previous.state;
	const restarted = patch.startedAt !== undefined && patch.startedAt !== previous.startedAt;
	if (!stateChanged && !restarted) {
		return null;
	}
	const end = options.live ? at : Math.min(at, previous.updatedAt);
	return { runningMs: (previous.runningMs ?? 0) + Math.max(0, end - since) };
}

/** The card's running time at `now`; null when its agent never ran (as far as the summary knows). */
export function readTaskRunningTime(
	summary: TaskRunningTimeSummary | null | undefined,
	now: number,
): TaskRunningTime | null {
	if (!summary) {
		return null;
	}
	const runningSince = getRunningSince(summary);
	const finishedMs = summary.runningMs ?? 0;
	if (runningSince === null && finishedMs <= 0) {
		return null;
	}
	return {
		totalMs: finishedMs + (runningSince === null ? 0 : Math.max(0, now - runningSince)),
		runningSince,
		runCount: summary.runCount ?? 0,
		firstRunStartedAt: summary.firstRunStartedAt ?? null,
	};
}

/** A duration for a narrow label: 45s, 12m, 1h 05m (rounded down). */
export function formatRunningDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
