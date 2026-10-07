// What recovery (recovery.ts) and the rework stage (rework.ts) both need to know about a card's sent rework, so the
// two stay out of each other's way: while a rework is fresh and hasn't shown up as started, the rework stage's
// started-check owns the card (restart once, then escalate) and recovery doesn't nudge, continue or retry it.
// Kept apart from rework.ts, which imports the engine and so recovery.

/** How long a sent rework may take to show up as running before the started-check restarts it (then escalates). */
export const REWORK_STARTED_CHECK_MS = 120_000;

/** The started-check restarts at one window and escalates at the next; the rework is "fresh" until then. */
export const REWORK_FRESH_MS = 2 * REWORK_STARTED_CHECK_MS;

export interface OpenRework {
	at: string;
	startedAt: string | null;
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
	return { at: last.at, startedAt: typeof last.startedAt === "string" ? last.startedAt : null };
}

/** A rework the started-check still owns: open, not seen started, and sent less than REWORK_FRESH_MS ago. */
export function isReworkAwaitingStart(rework: OpenRework | null, now: number): boolean {
	return Boolean(rework && !rework.startedAt && now - Date.parse(rework.at) < REWORK_FRESH_MS);
}
