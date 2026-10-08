// What the watchdog asks the Kanban server to do. The watchdog runs in the pipeline worker (plan §5), which never
// writes the board or touches a PTY itself: it sends one of these requests over the worker's IPC channel and the
// server (src/server/watchdog-actions.ts) carries it out with its own session manager and state lock.
import type { RuntimeAgentId, RuntimeTaskInputDeliveryResponse } from "../../core/api-contract";

export type WatchdogActionRequest =
	/** Types text into a card's (or the orchestrator sidebar's) agent TUI through deliverTaskInput. */
	/**
	 * `fromWorkspaceId`: the workspace whose board the input is for (an orchestrator wake); required for a home-agent (orchestrator)
	 * session id: the server refuses such a delivery without it, or into another workspace's session, in every isolation
	 * mode (src/server/watchdog-actions.ts), so the check can't be skipped by leaving the field out. The watchdog always
	 * sends its own workspace here: a workspace's items wake only its own orchestrator.
	 */
	| { kind: "deliverInput"; workspaceId: string; taskId: string; text: string; fromWorkspaceId?: string }
	/** Sends Esc to a running agent (PID brownout: the agent cancels its turn, the card keeps its session). */
	| { kind: "interrupt"; workspaceId: string; taskId: string }
	/**
	 * Starts the workspace's orchestrator sidebar session (`createHomeAgentSessionId(ws, agentId)`) server-side with
	 * `prompt` as its first input. Only the browser starts it otherwise. Starting a live session returns it unchanged
	 * (TerminalSessionManager.startTaskSession), so the browser and the watchdog never get two.
	 */
	| {
			kind: "startOrchestratorSession";
			workspaceId: string;
			agentId: RuntimeAgentId;
			prompt: string;
			/** The workspace whose board needs the orchestrator (required; the server refuses another workspace's). */
			fromWorkspaceId: string;
	  }
	/** Deletes Done cards older than `days` after a backup (src/state/board-prune.ts). */
	| { kind: "pruneDone"; workspaceId: string; days: number }
	/** Runs the orphan process sweep now (PID pressure). */
	| { kind: "sweepProcesses" }
	/**
	 * Project isolation: a session credential for a headless orchestrator run of `workspaceId` (its env carries it, so
	 * the run's `kanban` calls are the workspace's orchestrator). Bound to the run's pid right after the spawn.
	 */
	| { kind: "issueOrchestratorCredential"; workspaceId: string; agentId: RuntimeAgentId }
	| { kind: "bindOrchestratorCredential"; credential: string; pid: number };

export interface WatchdogActionResults {
	deliverInput: RuntimeTaskInputDeliveryResponse;
	interrupt: { ok: boolean; error?: string };
	startOrchestratorSession: { ok: boolean; taskId: string; error?: string };
	pruneDone: { ok: boolean; summary: string; error?: string };
	issueOrchestratorCredential: { ok: boolean; credential: string | null; error?: string };
	bindOrchestratorCredential: { ok: boolean };
	sweepProcesses: {
		ok: boolean;
		supported: boolean;
		orphans: number;
		terminated: number;
		zombies: number;
		error?: string;
	};
}

export type WatchdogActionResult<Kind extends WatchdogActionRequest["kind"]> = WatchdogActionResults[Kind];

export interface WatchdogActions {
	request: <Request extends WatchdogActionRequest>(request: Request) => Promise<WatchdogActionResult<Request["kind"]>>;
}
