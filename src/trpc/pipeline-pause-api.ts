// The runtime side of `kanban pipeline pause|resume` (src/pipeline/workspace-pause.ts, issue #23): one workspace's QA
// pipeline is held or let go. The server decides who calls with the strict caller lookup, in every isolation mode,
// off included, as for the kit's project settings (kit-settings-api.ts):
//   - the user: allowed;
//   - the orchestrator of THAT workspace (its sidebar session or its headless wake): allowed;
//   - another workspace's orchestrator, any card session, an unidentified caller: refused (isolation log).
// A change is logged in the workspace's decision log (stage `pause`); the worker gets a snapshot of the workspace at
// once (a resume starts its queued QA cards) and the browser the project list (the board's "QA paused" badge).
import { z } from "zod";

import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import { createPipelineDecisionLog, type PipelineDecisionLog } from "../pipeline/decision-log";
import { setWorkspacePipelinePaused } from "../pipeline/workspace-pause";

export const pipelinePauseRequestSchema = z.object({
	paused: z.boolean(),
	reason: z.string().max(500).optional(),
});

export const pipelinePauseResponseSchema = z.object({
	ok: z.boolean(),
	paused: z.boolean(),
	changed: z.boolean(),
	/** ISO time of the pause in force, or null. */
	pausedAt: z.string().nullable(),
	message: z.string().optional(),
	error: z.string().optional(),
});
export type PipelinePauseResponse = z.infer<typeof pipelinePauseResponseSchema>;

export type PipelinePauseCallerDecision = { allowed: true; by: string } | { allowed: false; message: string };

/** Who may pause or resume `workspaceId`'s QA pipeline: the user and that project's own orchestrator. */
export function decidePipelinePauseCaller(caller: RuntimeCaller, workspaceId: string): PipelinePauseCallerDecision {
	if (caller.kind === "user") {
		return { allowed: true, by: "user" };
	}
	if (caller.kind === "session" && caller.session.role === "orchestrator") {
		if (caller.session.workspaceId === workspaceId) {
			return { allowed: true, by: `orchestrator ${caller.session.taskId}` };
		}
		return {
			allowed: false,
			message: `The QA pipeline of ${workspaceId} is paused and resumed only by the user and ${workspaceId}'s own orchestrator, not ${describeCaller(caller)}. Send ${workspaceId}'s orchestrator a message (kanban message send).`,
		};
	}
	return {
		allowed: false,
		message: `A project's QA pipeline is paused and resumed only by the user and the project's orchestrator; ${describeCaller(caller)} can't. Tell your orchestrator what you need.`,
	};
}

export interface RuntimePipelinePauseApi {
	setPaused: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		request: z.infer<typeof pipelinePauseRequestSchema>;
	}) => Promise<PipelinePauseResponse>;
}

export interface CreatePipelinePauseApiDependencies {
	log: IsolationService["log"];
	/** Asks the pipeline worker host for a snapshot of the workspace now. */
	requestSnapshot?: (workspaceId: string) => void;
	/** Sends every client the project list again (its `pipelinePaused` flags). */
	broadcastProjects?: (workspaceId: string) => void;
	decisionLog?: PipelineDecisionLog;
	/** Tests: where config.json lives. */
	configPath?: string;
	now?: () => number;
}

export function createPipelinePauseApi(deps: CreatePipelinePauseApiDependencies): RuntimePipelinePauseApi {
	const decisionLog = deps.decisionLog ?? createPipelineDecisionLog();
	return {
		setPaused: async ({ caller, workspaceId, request }) => {
			const action = request.paused ? "pipeline.pause" : "pipeline.resume";
			const decision = decidePipelinePauseCaller(caller, workspaceId);
			if (!decision.allowed) {
				await deps.log([workspaceId, caller.kind === "session" ? caller.session.workspaceId : null], {
					kind: "refused",
					taskId: caller.kind === "session" ? caller.session.taskId : null,
					from: caller.kind === "session" ? caller.session.workspaceId : null,
					to: workspaceId,
					action,
					detail: `pausing the QA pipeline is the user's and the project orchestrator's (${caller.kind === "session" ? `${caller.session.role} via ${caller.via}` : caller.kind === "unknown" ? caller.reason : "user"})`,
				});
				return { ok: false, paused: false, changed: false, pausedAt: null, error: decision.message };
			}
			try {
				const change = await setWorkspacePipelinePaused({
					workspaceId,
					paused: request.paused,
					by: decision.by,
					reason: request.reason ?? null,
					decisionLog,
					configPath: deps.configPath,
					now: deps.now,
				});
				if (change.changed) {
					deps.requestSnapshot?.(workspaceId);
					deps.broadcastProjects?.(workspaceId);
				}
				const notQa =
					change.landingMode === "qa"
						? ""
						: ` ${workspaceId} is on landing mode ${change.landingMode}, so the pipeline QAs nothing there; the pause applies once it is on qa.`;
				const message = change.paused
					? `${change.changed ? "Paused" : "Already paused"}${change.pausedAt ? ` since ${change.pausedAt}` : ""}: new QA cards are queued in Backlog and none starts; no PASS lands and no rework is sent. A running QA card goes on; \`kanban task done\` on it queues a replacement that waits too. Resume with \`kanban pipeline resume\`.${notQa}`
					: `${change.changed ? "Resumed" : "Not paused"}: queued QA cards start (oldest first, within the QA slots and provider capacity), PASSes land and reworks are sent.${notQa}`;
				return { ok: true, paused: change.paused, changed: change.changed, pausedAt: change.pausedAt, message };
			} catch (error) {
				return {
					ok: false,
					paused: false,
					changed: false,
					pausedAt: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
