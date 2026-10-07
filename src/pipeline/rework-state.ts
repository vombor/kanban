// What recovery (recovery.ts) and the rework stage (rework.ts) both need to know about a card's sent rework, so the
// two stay out of each other's way: while a rework is fresh and hasn't shown up as started, the rework stage's
// started-check owns the card (restart once, then escalate) and recovery doesn't nudge, continue or retry it.
// Kept apart from rework.ts, which imports the engine and so recovery.

/** How long a sent rework may take to show up as running before the started-check restarts it (then escalates). */
export const REWORK_STARTED_CHECK_MS = 120_000;

export interface OpenRework {
	at: string;
	startedAt: string | null;
	/** When the started-check restarted it (or found it could not), null before that. */
	restartAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The newest rework when it hasn't returned and isn't closed (by a handback or a resend), else null. */
export function readOpenRework(qaflow: Record<string, unknown>): OpenRework | null {
	const last = Array.isArray(qaflow.reworks) ? qaflow.reworks.at(-1) : undefined;
	if (!isRecord(last) || typeof last.at !== "string" || last.returned || last.closedBy) {
		return null;
	}
	return {
		at: last.at,
		startedAt: typeof last.startedAt === "string" ? last.startedAt : null,
		restartAt: typeof last.restartAt === "string" ? last.restartAt : null,
	};
}

/**
 * A rework the started-check still owns: open and not seen started, and not restarted yet (whatever its age: with a
 * slow or stopped worker the started-check runs late, and recovery must not act on the card in the same evaluation)
 * or restarted less than REWORK_STARTED_CHECK_MS ago (the started-check escalates then). Keyed on the restart, not
 * the send.
 */
export function isReworkAwaitingStart(rework: OpenRework | null, now: number): boolean {
	if (!rework || rework.startedAt) {
		return false;
	}
	return !rework.restartAt || now - Date.parse(rework.restartAt) < REWORK_STARTED_CHECK_MS;
}
