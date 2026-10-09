// Whether a project's orchestrator waits for the user (issue #10): its home-agent sidebar sessions
// (`__home_agent__:<ws>:<agent>`) read through the one reader, describeUserInputWait() in
// src/terminal/user-input-wait.ts. Only a session with a process can wait: a summary hydrated after a restart, or a
// session that ended, never does. Headless orchestrator runs (the watchdog's `claude -p`/`codex exec` wakes) have
// no terminal anyone could answer in, so they never count. Every project's answer goes into its project summary
// (`orchestratorWait`, kind and start only) and the question itself only to `workspace.getOrchestratorWait`, which
// project isolation scopes to the workspace.
import type { RuntimeOrchestratorWaitDetail } from "../core/api-contract";
import { isHomeAgentSessionIdForWorkspace } from "../core/home-agent-session";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { describeUserInputWait } from "../terminal/user-input-wait";

export type OrchestratorWaitSessions = Pick<
	TerminalSessionManager,
	"listSummaries" | "hasLiveProcess" | "getViewerInputSubmittedAt"
>;

/** The workspace's oldest unanswered orchestrator wait, or null. */
export function findOrchestratorWait(
	sessions: OrchestratorWaitSessions | null,
	workspaceId: string,
): RuntimeOrchestratorWaitDetail | null {
	let found: RuntimeOrchestratorWaitDetail | null = null;
	for (const summary of sessions?.listSummaries() ?? []) {
		if (!isHomeAgentSessionIdForWorkspace(summary.taskId, workspaceId) || !sessions?.hasLiveProcess(summary.taskId)) {
			continue;
		}
		const wait = describeUserInputWait(summary, { answeredAt: sessions.getViewerInputSubmittedAt(summary.taskId) });
		if (wait && (!found || wait.since < found.since)) {
			found = { ...wait, taskId: summary.taskId, agentId: summary.agentId };
		}
	}
	return found;
}
