// The server side of the watchdog's actions (src/pipeline/watchdog/actions.ts). The watchdog runs in the pipeline
// worker and asks; the server owns the PTYs, the board and the process reaper, so it does the work here:
//   - typed input goes through deliverTaskInput (text, Enter, activity check), the one delivery path (plan §4.4);
//   - the orchestrator sidebar session is started like the browser starts it (runtime.startTaskSession with the home
//     agent session id), so a browser that opens later attaches to the same session instead of starting a second;
//   - prune-done edits the board under the workspace lock and tells the browsers;
//   - the PID-pressure sweep is the orphan process sweeper's own sweep.
import type {
	RuntimeProcessSweepResult,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
} from "../core/api-contract";
import { createHomeAgentSessionId } from "../core/home-agent-session";
import type { WatchdogActionRequest, WatchdogActionResults } from "../pipeline/watchdog/actions";
import { pruneDoneCards } from "../pipeline/watchdog/prune-done";
import { deliverTaskInput, type TaskInputTerminal } from "../terminal/deliver-task-input";

const ESC = "\u001b";

export interface WatchdogActionScope {
	workspaceId: string;
	workspacePath: string;
}

export interface WatchdogActionDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	getTerminal: (scope: WatchdogActionScope) => Promise<TaskInputTerminal>;
	startTaskSession: (
		scope: WatchdogActionScope,
		input: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
	runProcessSweep: () => Promise<{ supported: boolean; lastSweep: RuntimeProcessSweepResult | null }>;
	onBoardMutated: (scope: WatchdogActionScope) => Promise<void>;
	pruneDone?: typeof pruneDoneCards;
}

export function createWatchdogActionHandler(
	deps: WatchdogActionDependencies,
): (request: WatchdogActionRequest) => Promise<WatchdogActionResults[WatchdogActionRequest["kind"]]> {
	const pruneDone = deps.pruneDone ?? pruneDoneCards;
	const scopeOf = (workspaceId: string): WatchdogActionScope => {
		const workspacePath = deps.getWorkspacePathById(workspaceId);
		if (!workspacePath) {
			throw new Error(`Workspace ${workspaceId} is not registered.`);
		}
		return { workspaceId, workspacePath };
	};

	return async (request) => {
		switch (request.kind) {
			case "deliverInput": {
				const terminal = await deps.getTerminal(scopeOf(request.workspaceId));
				return await deliverTaskInput(terminal, request.taskId, request.text);
			}
			case "interrupt": {
				const terminal = await deps.getTerminal(scopeOf(request.workspaceId));
				const summary = terminal.writeInput(request.taskId, Buffer.from(ESC, "utf8"));
				return summary ? { ok: true } : { ok: false, error: "Task session is not running." };
			}
			case "startOrchestratorSession": {
				const taskId = createHomeAgentSessionId(request.workspaceId, request.agentId);
				const response = await deps.startTaskSession(scopeOf(request.workspaceId), {
					taskId,
					prompt: request.prompt,
					// A home agent session runs in the project itself; the base ref is not used for it.
					baseRef: "HEAD",
					agentId: request.agentId,
				});
				return response.ok
					? { ok: true, taskId }
					: { ok: false, taskId, error: response.error ?? "could not start the session" };
			}
			case "pruneDone": {
				const scope = scopeOf(request.workspaceId);
				const result = await pruneDone({
					workspaceId: request.workspaceId,
					repoPath: scope.workspacePath,
					days: request.days,
				});
				if (result.pruned.length > 0 && result.backupPath) {
					await deps.onBoardMutated(scope);
				}
				return { ok: true, summary: result.summary };
			}
			case "sweepProcesses": {
				const response = await deps.runProcessSweep();
				const sweep = response.lastSweep;
				return {
					ok: response.supported && sweep !== null && sweep.error === null,
					supported: response.supported,
					orphans: sweep?.orphans.length ?? 0,
					terminated:
						sweep?.orphans.filter((orphan) => orphan.action === "terminated" || orphan.action === "killed")
							.length ?? 0,
					zombies: sweep?.zombies.length ?? 0,
					...(sweep?.error ? { error: sweep.error } : {}),
				};
			}
		}
	};
}
