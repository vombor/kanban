import { updatePipelineConfigFile } from "../config/pipeline-config";
import { resolveCardRole } from "../core/card-role";
import { providerConcurrencySchema } from "../core/provider-concurrency";
import { createPipelineStateStore, type PipelineStateStore } from "../pipeline/pipeline-state";
import { readQaGateEntry } from "../pipeline/qa-gate";
import { triageFingerprint } from "../pipeline/triage-acknowledgement";
import { readEscalation } from "../pipeline/watchdog/stalls";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import type { RuntimePipelineControlApi } from "../trpc/pipeline-control-contract";
import { decidePipelinePauseCaller } from "../trpc/pipeline-pause-api";

export function createPipelineControlApi(options: {
	store?: PipelineStateStore;
	readBoard?: typeof loadWorkspaceBoardById;
	isLive: (workspaceId: string, taskId: string) => boolean;
	isRunning?: (workspaceId: string, taskId: string) => boolean;
	wake: (workspaceId: string) => void;
	canReview?: (workspaceId: string) => Promise<boolean>;
	now?: () => number;
}): RuntimePipelineControlApi {
	const store = options.store ?? createPipelineStateStore();
	return {
		request: async (caller, workspaceId, request) => {
			const decision = decidePipelinePauseCaller(caller, workspaceId);
			if (!decision.allowed) return { ok: false, error: decision.message };
			try {
				if (request.kind === "pacing") {
					await updatePipelineConfigFile((config) => {
						const raw =
							config.workspaces && typeof config.workspaces === "object" && !Array.isArray(config.workspaces)
								? (config.workspaces as Record<string, unknown>)
								: {};
						const own =
							raw[workspaceId] && typeof raw[workspaceId] === "object"
								? (raw[workspaceId] as Record<string, unknown>)
								: {};
						const limits = providerConcurrencySchema.parse(own.providerConcurrency ?? {});
						if (request.limit === null) delete limits[request.provider];
						else limits[request.provider] = request.limit;
						return { ...config, workspaces: { ...raw, [workspaceId]: { ...own, providerConcurrency: limits } } };
					});
					options.wake(workspaceId);
					return {
						ok: true,
						message:
							"Own-project pacing updated. The shared provider's effective cap is the minimum of user/project caps; this cannot raise or override another project's cap. Existing turns are not interrupted.",
					};
				}
				const board = await (options.readBoard ?? loadWorkspaceBoardById)(workspaceId);
				if (
					!board.columns.some(
						(column) => column.id !== "trash" && column.cards.some((card) => card.id === request.taskId),
					)
				)
					throw new Error("The target card is missing or Done; finished experiments are not reopened.");
				if (request.kind !== "acknowledge") {
					const card = board.columns.flatMap((column) => column.cards).find((card) => card.id === request.taskId);
					if (!card || resolveCardRole(card) !== "dev")
						throw new Error(
							"Review controls target dev snapshots; non-dev assessments continue with task resume.",
						);
					if (options.canReview && !(await options.canReview(workspaceId)))
						throw new Error(
							"Review controls require an active non-shadow landing=qa worker; no global policy is changed.",
						);
				}
				const at = new Date((options.now ?? Date.now)()).toISOString();
				await store.update(workspaceId, (state) => {
					const entry = state.cards[request.taskId] ?? {};
					if (request.kind === "acknowledge") {
						if (!readEscalation(entry)) throw new Error("The card has no current escalation to acknowledge.");
						if (
							request.waitForTaskId &&
							!board.columns.some((column) => column.cards.some((card) => card.id === request.waitForTaskId))
						)
							throw new Error("Prerequisite is not on this project's board.");
						if (request.until && Date.parse(request.until) <= Date.parse(at))
							throw new Error("The retry time must be in the future.");
						return {
							...state,
							cards: {
								...state.cards,
								[request.taskId]: {
									...entry,
									triageAck:
										request.disposition === "clear"
											? null
											: {
													disposition: request.disposition,
													reason: request.reason,
													until: request.until ?? null,
													waitForTaskId: request.waitForTaskId ?? null,
													prerequisite: request.waitForTaskId
														? triageFingerprint(board, state.cards, request.waitForTaskId)
														: null,
													fingerprint: triageFingerprint(board, state.cards, request.taskId),
													at,
													by: decision.by,
												},
									controlHistory: [
										...(Array.isArray(entry.controlHistory) ? entry.controlHistory : []),
										{ ...request, at, by: decision.by },
									],
								},
							},
						};
					}
					if (entry.snapshot !== request.snapshot)
						throw new Error("Snapshot changed or is not recorded; provide the exact current immutable snapshot.");
					if ((options.isRunning ?? options.isLive)(workspaceId, request.taskId))
						throw new Error("The implementation is running; do not conclude or re-review its changing work.");
					const linked = typeof entry.qaCard === "string" ? entry.qaCard : null;
					if (linked && options.isLive(workspaceId, linked))
						throw new Error(
							"The current reviewer is still live; stop it explicitly before changing review disposition.",
						);
					if (request.kind === "conclude") {
						const qa = readQaGateEntry(state.cards[request.qaTaskId]);
						if (!qa || qa.reviewsTaskId !== request.taskId || qa.snapshot !== request.snapshot)
							throw new Error("Reviewer/snapshot do not belong to this card.");
						if (options.isLive(workspaceId, request.qaTaskId)) throw new Error("The reviewer is still live.");
						if (qa.status === "ingested")
							throw new Error("An official verdict was already ingested; it is immutable.");
					}
					if (
						entry.manualReview &&
						typeof entry.manualReview === "object" &&
						"status" in entry.manualReview &&
						["pending", "running"].includes(String(entry.manualReview.status))
					)
						throw new Error("A manual review control is already pending/running.");
					return {
						...state,
						cards: {
							...state.cards,
							[request.taskId]: {
								...entry,
								manualReview: { ...request, at, by: decision.by, status: "pending" },
								controlHistory: [
									...(Array.isArray(entry.controlHistory) ? entry.controlHistory : []),
									{ ...request, at, by: decision.by },
								],
							},
						},
					};
				});
				options.wake(workspaceId);
				return {
					ok: true,
					message:
						request.kind === "acknowledge"
							? "Disposition recorded without clearing escalation or changing QA/landing policy."
							: "Exact-snapshot manual control queued; no global resume or automatic implementation retry authorized.",
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
