import { TRPCError } from "@trpc/server";
import type { PipelineConfig } from "../config/pipeline-config";
import type {
	RuntimeAgentId,
	RuntimeBoardData,
	RuntimePipelineCardStage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { type EffectiveModelConfig, resolveEffectiveModel } from "../core/effective-agent";
import { getBoardPrerequisiteStatuses } from "../core/task-prerequisites";
import { authorizeKnowledgeCaller } from "../knowledge/knowledge-api";
import type { PlanBundleStore } from "../knowledge/plan-bundle-store";
import { type PlanBreakdownCard, parsePlanBreakdown } from "../plans/plan-breakdown";
import type { PlanIndexStore } from "../plans/plan-index";
import { isReviewSettled } from "../terminal/review-settle";
import type { CoordinationTask, RuntimeCoordinationApi } from "../trpc/coordination-contract";
import { executionTaskIdSchema } from "../trpc/knowledge-execution-contract";
import type { RuntimeProviderCapacityApi } from "../trpc/provider-capacity-api";
import { buildCoordinationReport } from "./report";
import { readCoordinationSnapshot } from "./snapshot-paths";

export interface CoordinationSource {
	repoPath: string;
	board: RuntimeBoardData;
	sessions: RuntimeTaskSessionSummary[];
	stages: RuntimePipelineCardStage[];
	selectedAgentId: RuntimeAgentId;
	config: PipelineConfig;
	agentDefaultModels: EffectiveModelConfig["agentDefaultModels"];
	settleMs?: number;
}
export function createCoordinationApi(deps: {
	load: (workspaceId: string) => Promise<CoordinationSource>;
	plans: Pick<PlanIndexStore, "read">;
	bundles: Pick<PlanBundleStore, "read" | "readPart">;
	capacity: RuntimeProviderCapacityApi;
	snapshot?: typeof readCoordinationSnapshot;
	now?: () => number;
}): RuntimeCoordinationApi {
	return {
		preview: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			try {
				const source = await deps.load(workspaceId),
					statuses = getBoardPrerequisiteStatuses(source.board);
				const boardEntries = source.board.columns.flatMap((column) =>
					column.cards.map((card) => ({ card, state: column.id })),
				);
				let entries: Array<{
					id: string;
					taskId: string | null;
					title: string;
					hint: PlanBreakdownCard["coordination"];
					local: PlanBreakdownCard | null;
				}> = [];
				let approvedBundle: string | null = null;
				let dependencies: Array<{ waiting: string; prerequisite: string; basis: "board" | "approved_plan" }> = [];
				if (input.planTaskId) {
					const plan = (await deps.plans.read(workspaceId)).plans[input.planTaskId];
					if (!plan?.approval?.bundleRevision)
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message:
								"Coordination needs an explicitly approved full bundle; no legacy or mutable-plan substitution was used.",
						});
					const bundle = await deps.bundles.read(workspaceId, plan.approval.bundleRevision);
					if (
						bundle.planTaskId !== input.planTaskId ||
						plan.approval.breakdownSha256 !== bundle.breakdown.contentHash ||
						(plan.expansion &&
							(plan.expansion.bundleRevision !== bundle.revision ||
								plan.expansion.breakdownSha256 !== bundle.breakdown.contentHash))
					)
						throw new Error("Plan binding mismatch");
					const parsed = parsePlanBreakdown(
						await deps.bundles.readPart(workspaceId, bundle.breakdown.contentHash),
						plan.slug,
					);
					if (!parsed.ok) throw new Error("Invalid retained breakdown");
					approvedBundle = bundle.revision;
					entries = parsed.breakdown.cards.map((card) => ({
						id: plan.expansion?.cards[card.id] ?? `planned:${card.id}`,
						taskId: plan.expansion?.cards[card.id] ?? null,
						title: card.title,
						hint: card.coordination,
						local: card,
					}));
					if (!plan.expansion)
						dependencies = parsed.breakdown.cards.flatMap((card) =>
							card.dependsOn.map((id) => ({
								waiting: `planned:${card.id}`,
								prerequisite: `planned:${id}`,
								basis: "approved_plan" as const,
							})),
						);
				} else
					entries = boardEntries
						.filter(({ card, state }) => state !== "trash" && resolveCardRole(card) === "dev")
						.slice(0, 100)
						.map(({ card }) => ({
							id: card.id,
							taskId: card.id,
							title: card.title,
							hint: undefined,
							local: null,
						}));
				const ids = new Set(entries.map((e) => e.id));
				dependencies.push(
					...source.board.dependencies
						.filter((edge) => ids.has(edge.fromTaskId))
						.map((edge) => ({ waiting: edge.fromTaskId, prerequisite: edge.toTaskId, basis: "board" as const })),
				);
				const tasks: CoordinationTask[] = [];
				for (const entry of entries) {
					if (entry.taskId) executionTaskIdSchema.parse(entry.taskId);
					const found = boardEntries.find(({ card }) => card.id === entry.taskId),
						card = found?.card;
					const session = source.sessions.find((s) => s.taskId === entry.taskId) ?? null;
					const stage = source.stages.find((s) => s.taskId === entry.taskId);
					const status = entry.taskId ? statuses.get(entry.taskId) : undefined;
					const model = card
						? resolveEffectiveModel(card, session, {
								selectedAgentId: source.selectedAgentId,
								agentDefaultModels: source.agentDefaultModels,
							})
						: null;
					const capacity =
						model?.provider && found?.state === "backlog"
							? await deps.capacity.check({
									workspaceId,
									request: { provider: model.provider, model: model.model },
								})
							: null;
					const ownerStates = [
						...(stage ? [stage.kind] : []),
						...(card?.providerQueue ? ["provider_admission_queued"] : []),
						...(session?.state === "running" ? ["session_running"] : []),
					];
					const blocked = ownerStates.length > 0 || (capacity?.hold !== null && capacity !== null);
					tasks.push({
						id: entry.id,
						taskId: entry.taskId,
						title: entry.title.slice(0, 200),
						state: found?.state ?? (entry.taskId ? "missing" : "planned"),
						prerequisites: status
							? {
									total: status.total,
									done: status.done,
									waiting: status.waitingOnTaskIds.slice(0, 100),
									missing: status.missingTaskIds.slice(0, 100),
								}
							: null,
						readiness: !entry.taskId
							? "planned_only"
							: !found
								? "blocked_or_unknown"
								: found.state !== "backlog"
									? "not_backlog"
									: status?.missingTaskIds.length
										? "missing_prerequisite"
										: status && status.done !== status.total
											? "waiting_on_prerequisites"
											: blocked
												? "blocked_or_unknown"
												: "prerequisites_satisfied",
						ownerStates,
						reviewSettled: isReviewSettled(session, (deps.now ?? Date.now)(), source.settleMs),
						model,
						capacityHold: found?.state === "backlog" && model?.provider ? Boolean(capacity?.hold) : null,
						otherProjectHolders: capacity?.hold?.otherWorkspaceHolders ?? 0,
						hints: entry.hint ?? null,
						...(card
							? await (deps.snapshot ?? readCoordinationSnapshot)(source.repoPath, card.id, card.baseRef)
							: { snapshot: null, baseCommit: null, observedPaths: [], pathsTruncated: true }),
					});
				}
				return buildCoordinationReport({
					tasks,
					dependencies: dependencies.slice(0, 300),
					planTaskId: input.planTaskId ?? null,
					approvedBundle,
					now: (deps.now ?? Date.now)(),
					truncated:
						dependencies.length > 300 ||
						(!input.planTaskId &&
							boardEntries.filter((e) => e.state !== "trash" && resolveCardRole(e.card) === "dev").length > 100),
					warnings: [
						"advisory_not_start_authorization",
						"native_dependencies_and_manual_choices_unchanged",
						"retained_snapshot_paths_do_not_include_unsubmitted_work",
						"provider_capacity_is_a_point_in_time_observation_not_a_reservation",
						"unknown_assignments_costs_and_durations_not_invented",
					],
					capacity: source.config.models.providerCapacity,
					concurrency: source.config.providerConcurrency,
				});
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Coordination sources are unavailable or inconsistent; no mutable fallback, start, assignment or dependency change was performed.",
				});
			}
		},
	};
}
