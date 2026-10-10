// The runtime side of `kanban task resubmit` (src/pipeline/resubmit.ts): a Review dev card is snapshotted again and
// its submission goes to the QA gate (issue #20). The server decides who calls with the strict caller lookup, in
// every isolation mode, off included, as for the kit's project settings (kit-settings-api.ts):
//   - the user: allowed;
//   - the orchestrator of THAT workspace (its sidebar session or its headless wake): allowed;
//   - another workspace's orchestrator, any card session, an unidentified caller: refused (isolation log).
// Only on landing mode `qa`, where the pipeline submits cards; elsewhere there is nothing to submit to. The request is
// recorded in pipeline-state and in the decision log (stage `resubmit`), and the worker gets a snapshot of the
// workspace at once; what the pipeline then does (snapshot, checks, the QA gate) is logged by it as usual.
import { z } from "zod";

import { getWorkspacePipelineSettings, type ParsedPipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { getTaskColumnId } from "../core/task-board-mutations";
import type { IsolationService } from "../isolation/isolation-service";
import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import { type KitCatalog, loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { createPipelineDecisionLog, type PipelineDecisionLog } from "../pipeline/decision-log";
import { createPipelineStateStore, type PipelineStateStore, readEscalatedAt } from "../pipeline/pipeline-state";
import { recordResubmitRequest } from "../pipeline/resubmit";

export const taskResubmitRequestSchema = z.object({ taskId: z.string().min(1) });

export const taskResubmitResponseSchema = z.object({
	ok: z.boolean(),
	taskId: z.string(),
	/** ISO time of the recorded request. */
	requestedAt: z.string().nullable(),
	message: z.string().optional(),
	error: z.string().optional(),
});
export type TaskResubmitResponse = z.infer<typeof taskResubmitResponseSchema>;

export type ResubmitCallerDecision = { allowed: true; by: string } | { allowed: false; message: string };

/** Who may resubmit `workspaceId`'s cards: the user and that project's own orchestrator. */
export function decideResubmitCaller(caller: RuntimeCaller, workspaceId: string): ResubmitCallerDecision {
	if (caller.kind === "user") {
		return { allowed: true, by: "user" };
	}
	if (caller.kind === "session" && caller.session.role === "orchestrator") {
		if (caller.session.workspaceId === workspaceId) {
			return { allowed: true, by: `orchestrator ${caller.session.taskId}` };
		}
		return {
			allowed: false,
			message: `Cards of ${workspaceId} are resubmitted only by the user and ${workspaceId}'s own orchestrator, not ${describeCaller(caller)}. Send ${workspaceId}'s orchestrator a message (kanban message send).`,
		};
	}
	return {
		allowed: false,
		message: `A card is resubmitted to the pipeline only by the user and the project's orchestrator; ${describeCaller(caller)} can't. Tell your orchestrator what you need.`,
	};
}

export interface RuntimePipelineResubmitApi {
	resubmit: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		request: z.infer<typeof taskResubmitRequestSchema>;
	}) => Promise<TaskResubmitResponse>;
}

export interface CreatePipelineResubmitApiDependencies {
	log: IsolationService["log"];
	loadWorkspaceState: (workspaceId: string) => Promise<RuntimeWorkspaceStateResponse | null>;
	/** The card's live session summary (the terminal manager's), newer than the stored one. */
	getLiveSession?: (workspaceId: string, taskId: string) => RuntimeTaskSessionSummary | null;
	/** Asks the pipeline worker host for a snapshot of the workspace now. */
	requestSnapshot?: (workspaceId: string) => void;
	readConfig?: () => Promise<ParsedPipelineConfig>;
	loadCatalog?: () => Promise<KitCatalog>;
	store?: PipelineStateStore;
	decisionLog?: PipelineDecisionLog;
	now?: () => number;
}

export function createPipelineResubmitApi(deps: CreatePipelineResubmitApiDependencies): RuntimePipelineResubmitApi {
	const readConfig = deps.readConfig ?? (async () => await readPipelineConfig());
	const loadCatalog = deps.loadCatalog ?? (async () => await loadKitCatalog());
	const store = deps.store ?? createPipelineStateStore();
	const decisionLog = deps.decisionLog ?? createPipelineDecisionLog();
	const now = deps.now ?? Date.now;

	return {
		resubmit: async ({ caller, workspaceId, request }) => {
			const { taskId } = request;
			const failure = (error: string): TaskResubmitResponse => ({ ok: false, taskId, requestedAt: null, error });
			const decision = decideResubmitCaller(caller, workspaceId);
			if (!decision.allowed) {
				await deps.log([workspaceId, caller.kind === "session" ? caller.session.workspaceId : null], {
					kind: "refused",
					taskId: caller.kind === "session" ? caller.session.taskId : null,
					from: caller.kind === "session" ? caller.session.workspaceId : null,
					to: workspaceId,
					action: "pipeline.resubmit",
					detail: `${taskId}: resubmitting is the user's and the project orchestrator's (${caller.kind === "session" ? `${caller.session.role} via ${caller.via}` : caller.kind === "unknown" ? caller.reason : "user"})`,
				});
				return failure(decision.message);
			}
			const parsed = await readConfig();
			const settings = getWorkspacePipelineSettings(parsed.config, workspaceId);
			if (settings.landing.mode !== "qa") {
				return failure(
					`${workspaceId} is on landing mode ${settings.landing.mode}: the pipeline submits no cards there, so there is nothing to resubmit to. Finish the card yourself (kanban task done).`,
				);
			}
			if (parsed.config.pipeline.paused) {
				return failure(
					"the pipeline is paused (pipeline.paused): nothing would act on a resubmit until it runs again.",
				);
			}
			const state = await deps.loadWorkspaceState(workspaceId);
			const card = state?.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
			if (!state || !card) {
				return failure(`Task "${taskId}" is not on ${workspaceId}'s board.`);
			}
			const columnId = getTaskColumnId(state.board, taskId);
			if (columnId !== "review") {
				return failure(
					`Task "${taskId}" is in ${columnId ?? "no column"}, not Review: only a Review card is submitted to the QA gate.`,
				);
			}
			const role = resolveCardRole(card);
			if (role !== "dev") {
				return failure(`Task "${taskId}" is a ${role} card: only dev cards are snapshotted and QA'd.`);
			}
			const session = deps.getLiveSession?.(workspaceId, taskId) ?? state.sessions[taskId] ?? null;
			if (session?.state === "running") {
				return failure(
					`Task "${taskId}" is still running: the pipeline snapshots it once its turn ends and its Review settles.`,
				);
			}
			const entry = (await store.peek(workspaceId))?.cards[taskId];
			const escalatedAt = readEscalatedAt(entry);
			if (escalatedAt) {
				return failure(
					`Task "${taskId}" was escalated ${escalatedAt}: it is not QA'd until \`kanban task handback\` gives it back to the pipeline.`,
				);
			}
			const at = new Date(now()).toISOString();
			await recordResubmitRequest(store, { workspaceId, taskId, request: { at, by: decision.by } });
			const resolution = resolveWorkspaceKit(parsed.config, workspaceId, await loadCatalog());
			const shadow = settings.pipeline.shadow;
			await decisionLog.append([
				{
					at,
					workspaceId,
					taskId,
					stage: "resubmit",
					kit: resolution.kitName,
					landingMode: settings.landing.mode,
					shadow,
					effectiveAgent: null,
					model: null,
					role,
					answer: { by: decision.by },
					outcome: "acted",
					note: `resubmit requested by ${decision.by}: the next evaluation snapshots the card again${shadow ? " (shadow: logged only)" : " and submits it to the QA gate"}`,
				},
			]);
			deps.requestSnapshot?.(workspaceId);
			return {
				ok: true,
				taskId,
				requestedAt: at,
				message: shadow
					? "Resubmitted: the pipeline snapshots the card again; the workspace is in shadow, so it only logs what it would do."
					: "Resubmitted: the pipeline snapshots the card again and submits a snapshot with changes to the QA gate (kanban task history / the decision log show what it did).",
			};
		},
	};
}
