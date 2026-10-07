// Reads a live card session's Cline CLI session files and asks evaluateClineTurnEnd whether its turn is over.
// Shared by the turn monitor (cline-turn-monitor.ts: ends turns Cline's TaskComplete hook missed) and session
// sync (session-column-sync.ts: keeps an idle Cline TUI's card in Review), so both find the session file the same
// way: the newest cline 3.x session whose cwd / workspace root is the summary's `workspacePath`, not the task id.
import type { ClineTurnDetectorSettings } from "../config/cline-turn-detector-config";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { type ClineSessionFileReader, getClineSessionsPath } from "./cline-session-files";
import { type ClineTurnEndDecision, evaluateClineTurnEnd } from "./cline-turn-outcome";

export type EndedClineTurn = Extract<ClineTurnEndDecision, { ended: true }>;

export interface ClineTurnCheckSessions {
	/** When the Kanban session entered its current state (for "running": when the turn started). */
	getStateEnteredAt: (taskId: string) => number | null;
}

export type LiveCardSessionSummary = RuntimeTaskSessionSummary & { workspacePath: string };

/** A card's (not the home agent's) session that Kanban reports running, with a process and a worktree. */
export function isLiveRunningCardSession(summary: RuntimeTaskSessionSummary): summary is LiveCardSessionSummary {
	return (
		summary.state === "running" &&
		summary.pid !== null &&
		summary.workspacePath !== null &&
		!isHomeAgentSessionId(summary.taskId)
	);
}

export interface ReadClineTurnEndInput {
	reader: ClineSessionFileReader;
	settings: Pick<ClineTurnDetectorSettings, "dataDir">;
	sessions: ClineTurnCheckSessions;
	summary: LiveCardSessionSummary;
	now: number;
	/** Passed to evaluateClineTurnEnd (default true). */
	requireStatus?: boolean;
}

export async function readClineTurnEnd(input: ReadClineTurnEndInput): Promise<ClineTurnEndDecision> {
	return evaluateClineTurnEnd({
		session: await input.reader.readLatestSession(
			getClineSessionsPath(input.settings.dataDir),
			input.summary.workspacePath,
		),
		runningSince: input.sessions.getStateEnteredAt(input.summary.taskId),
		now: input.now,
		requireStatus: input.requireStatus,
	});
}

/** For logs: "status_line STATUS: DONE", "final_reply after a bounce to running", … */
export function describeClineTurnEnd(decision: EndedClineTurn): string {
	const status = decision.statusLine ? ` STATUS: ${decision.statusLine.kind}` : "";
	return `${decision.reason}${status}${decision.afterBounce ? " after a bounce to running" : ""}`;
}
