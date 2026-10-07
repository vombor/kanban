// What the watchdog asks the Kanban server to do. The watchdog runs in the pipeline worker (plan §5), which never
// writes the board or touches a PTY itself: it sends one of these requests over the worker's IPC channel and the
// server (src/server/watchdog-actions.ts) carries it out with its own session manager and state lock.
import type { RuntimeAgentId, RuntimeTaskInputDeliveryResponse } from "../../core/api-contract";

export type WatchdogActionRequest =
	/** Types text into a card's (or the orchestrator sidebar's) agent TUI through deliverTaskInput. */
	| { kind: "deliverInput"; workspaceId: string; taskId: string; text: string }
	/** Sends Esc to a running agent (PID brownout: the agent cancels its turn, the card keeps its session). */
	| { kind: "interrupt"; workspaceId: string; taskId: string }
	/**
	 * Starts the workspace's orchestrator sidebar session (`createHomeAgentSessionId(ws, agentId)`) server-side with
	 * `prompt` as its first input. Only the browser starts it otherwise. Starting a live session returns it unchanged
	 * (TerminalSessionManager.startTaskSession), so the browser and the watchdog never get two.
	 */
	| { kind: "startOrchestratorSession"; workspaceId: string; agentId: RuntimeAgentId; prompt: string }
	/** Deletes Done cards older than `days` after a backup (src/state/board-prune.ts). */
	| { kind: "pruneDone"; workspaceId: string; days: number }
	/** Runs the orphan process sweep now (PID pressure). */
	| { kind: "sweepProcesses" };

export interface WatchdogActionResults {
	deliverInput: RuntimeTaskInputDeliveryResponse;
	interrupt: { ok: boolean; error?: string };
	startOrchestratorSession: { ok: boolean; taskId: string; error?: string };
	pruneDone: { ok: boolean; summary: string; error?: string };
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
