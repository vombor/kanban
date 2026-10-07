// The watchdog's per-workspace bookkeeping: `data/<ws>/watchdog-state.json` (was the legacy kit's
// review-watch-state.json: `triaged`, `resumed`, `paused`, `woken`, `wakeRetry`, `wakeEnter`). The worker is its only
// writer. A missing or unreadable file starts empty: the worst case is one repeated wake or continue.
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { lockedFileSystem } from "../../fs/locked-file-system";

/** Entries older than this are dropped on save, so the maps don't grow forever. */
const KEEP_MS = 7 * 24 * 60 * 60_000;

const isoMapSchema = z.record(z.string(), z.string()).default({});

export const watchdogWorkspaceStateSchema = z.object({
	version: z.literal(1).default(1),
	/** Issue key → when it was last queued for the orchestrator (cooldown `watchdog.triageCooldownMin`). */
	triaged: isoMapSchema,
	/** `<taskId>:<session updatedAt>` → when the one LLM-free continue was sent for that dead session. */
	resumed: isoMapSchema,
	/** Task id → when the PID brownout paused it. */
	paused: isoMapSchema,
	/** Wake key → when the orchestrator was last woken for it (cooldown `orchestrator.wake.cooldownMin`). */
	woken: isoMapSchema,
	/** Items a failed wake kept for the next tick (they come from a queue, not from the recomputed ATTENTION list). */
	wakeRetry: z.array(z.object({ item: z.string(), at: z.string() })).default([]),
	/** Text typed into the sidebar whose Enter did not take: the next tick sends only Enter. */
	wakeEnter: z
		.object({ taskId: z.string(), at: z.string(), items: z.array(z.string()) })
		.nullable()
		.default(null),
	/** Job name → when it last ran (core jobs such as prune-done and the kit features' jobs). */
	jobs: isoMapSchema,
});
export type WatchdogWorkspaceState = z.infer<typeof watchdogWorkspaceStateSchema>;

export function createEmptyWatchdogState(): WatchdogWorkspaceState {
	return watchdogWorkspaceStateSchema.parse({});
}

export async function loadWatchdogState(path: string): Promise<WatchdogWorkspaceState> {
	try {
		const parsed = watchdogWorkspaceStateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
		return parsed.success ? parsed.data : createEmptyWatchdogState();
	} catch {
		return createEmptyWatchdogState();
	}
}

function pruneIsoMap(map: Record<string, string>, now: number): Record<string, string> {
	return Object.fromEntries(Object.entries(map).filter(([, at]) => now - Date.parse(at) < KEEP_MS));
}

export async function saveWatchdogState(path: string, state: WatchdogWorkspaceState, now: number): Promise<void> {
	const pruned: WatchdogWorkspaceState = {
		...state,
		triaged: pruneIsoMap(state.triaged, now),
		resumed: pruneIsoMap(state.resumed, now),
		paused: pruneIsoMap(state.paused, now),
		woken: pruneIsoMap(state.woken, now),
	};
	await lockedFileSystem.writeJsonFileAtomic(path, pruned);
}
