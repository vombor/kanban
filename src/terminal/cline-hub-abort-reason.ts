// The reasons Kanban gives the Cline hub's `run.abort` (cline-hub-client.ts, issue #28). Cline writes the reason word
// for word into the run's session as its own error notice (an assistant message with `metadata.displayRole:
// "error"`), the same mark it puts on provider errors such as "No model loaded: <model>". So every reason starts with
// one marker, and recovery's detector (detectFinalProviderError in src/pipeline/recovery-detect.ts) never reads a
// notice carrying it as a provider error: a run Kanban ended is not one to retry (issue #32). Kept apart from the
// hub client so the pipeline's detector doesn't import the websocket client.

/** The start of every reason Kanban passes to `run.abort`. */
export const KANBAN_CLINE_HUB_ABORT_MARKER = "Kanban ended this run: ";

/** The reasons Kanban ends a hub run for today; a new one goes here, so it carries the marker. */
export const KANBAN_CLINE_HUB_ABORT_REASONS = {
	/** The card's TUI exited (cline-hub-run-follower.ts). */
	tuiExited: (exitCode: number | null): string =>
		`${KANBAN_CLINE_HUB_ABORT_MARKER}its card's Cline TUI exited${exitCode === null ? "" : ` (code ${exitCode})`}`,
	/** The card's TUI died with the previous server (a restart orphan; cline-hub-run-follower.ts). */
	orphaned: `${KANBAN_CLINE_HUB_ABORT_MARKER}its card's Cline TUI died with the previous Kanban server`,
	/** Done, task delete, project removal (runtime-server.ts prepareTaskProcessReap). */
	doneOrDeleted: `${KANBAN_CLINE_HUB_ABORT_MARKER}its card is done or deleted`,
} as const;

/** The reason as sent to `run.abort`: with the marker, added when missing. */
export function withKanbanClineHubAbortMarker(reason: string): string {
	return reason.startsWith(KANBAN_CLINE_HUB_ABORT_MARKER) ? reason : `${KANBAN_CLINE_HUB_ABORT_MARKER}${reason}`;
}

/** Whether a session message's text is the reason of a run Kanban ended through the hub. */
export function isKanbanClineHubAbortReason(text: string): boolean {
	return text.trim().startsWith(KANBAN_CLINE_HUB_ABORT_MARKER);
}
