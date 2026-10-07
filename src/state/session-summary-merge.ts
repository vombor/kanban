// Session summaries have two writers: the server persists every summary change itself (session-summary-persister.ts),
// and the browser's board saves carry the summaries the browser last saw. A browser save can therefore hold an older
// summary than the one on disk, so every write of sessions.json goes through this merge: per task the newer summary
// wins, and a summary only on disk is kept (the browser not knowing a session doesn't delete it). Then the result is
// pruned by the board the write stores, so a summary doesn't outlive its card.
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../core/api-contract";
import { getDetailTerminalTaskId } from "../core/detail-terminal-session";
import { isHomeAgentSessionId } from "../core/home-agent-session";

export type SessionSummaryRecord = Record<string, RuntimeTaskSessionSummary>;

/** Whether `candidate` is older than `current`: by `updatedAt`, then by `stateChangedAt`. Ties go to the candidate. */
export function isOlderSessionSummary(
	candidate: Pick<RuntimeTaskSessionSummary, "updatedAt" | "stateChangedAt">,
	current: Pick<RuntimeTaskSessionSummary, "updatedAt" | "stateChangedAt">,
): boolean {
	if (candidate.updatedAt !== current.updatedAt) {
		return candidate.updatedAt < current.updatedAt;
	}
	return (candidate.stateChangedAt ?? 0) < (current.stateChangedAt ?? 0);
}

/**
 * The summaries of `sessions` that belong to the board: a card's (any column, Done included), its detail terminal's
 * (`__detail_terminal__:<card id>`), and the home-agent sidebar sessions (`__home_agent__:<workspace>:<agent>`), which
 * have no card and are never pruned by the board.
 */
export function pruneSessionSummariesByBoard(
	sessions: SessionSummaryRecord,
	board: RuntimeBoardData,
): SessionSummaryRecord {
	const keptIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			keptIds.add(card.id);
			keptIds.add(getDetailTerminalTaskId(card.id));
		}
	}
	return Object.fromEntries(
		Object.entries(sessions).filter(([taskId]) => keptIds.has(taskId) || isHomeAgentSessionId(taskId)),
	);
}

/**
 * `stored` with every summary of `incoming` that is not older than the stored one for the same task, pruned by
 * `board` (the board stored with them). `board` null (the stored board can't be read) prunes nothing.
 */
export function mergeSessionSummaries(
	stored: SessionSummaryRecord,
	incoming: SessionSummaryRecord,
	board: RuntimeBoardData | null,
): SessionSummaryRecord {
	const merged: SessionSummaryRecord = { ...stored };
	for (const [taskId, summary] of Object.entries(incoming)) {
		const current = stored[taskId];
		if (!current || !isOlderSessionSummary(summary, current)) {
			merged[taskId] = summary;
		}
	}
	return board ? pruneSessionSummariesByBoard(merged, board) : merged;
}
