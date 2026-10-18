import { TRPCError } from "@trpc/server";
import type { RuntimeBoardData } from "../core/api-contract";
import type { TaskContextStore } from "../knowledge/task-context-store";
import { authorizeObjectiveCaller } from "../objectives/objective-api";
import type { ObjectiveStore } from "../objectives/objective-store";
import type { PlanIndexStore } from "../plans/plan-index";
import type { RuntimeEfficiencyApi } from "../trpc/efficiency-contract";
import { buildEfficiencyReport } from "./report";
import type { createEfficiencyTimingStore } from "./timing-store";

export function createEfficiencyApi(deps: {
	objectives: Pick<ObjectiveStore, "read">;
	plans: Pick<PlanIndexStore, "read">;
	contexts: Pick<TaskContextStore, "bindings">;
	timing: ReturnType<typeof createEfficiencyTimingStore>;
	board: (workspaceId: string) => Promise<RuntimeBoardData>;
	now?: () => number;
}): RuntimeEfficiencyApi {
	return {
		report: async (caller, workspaceId, input) => {
			authorizeObjectiveCaller(caller, workspaceId);
			try {
				let objectives = (await deps.objectives.read(workspaceId)).objectives;
				const timing = await deps.timing.read(workspaceId),
					board = await deps.board(workspaceId);
				let taskIds = new Set([
					...board.columns.flatMap((column) => column.cards.map((card) => card.id)),
					...timing.spans.map((span) => span.taskId),
					...timing.agentSamples.map((sample) => sample.taskId),
					...objectives.flatMap((objective) => objective.tasks.map((task) => task.taskId)),
				]);
				let scope: "project" | "task" | "objective" | "plan" = "project",
					attachedAfter: Map<string, number> | undefined;
				if (input.taskId) {
					if (!taskIds.has(input.taskId))
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Task is not recorded in this project's report sources.",
						});
					scope = "task";
					taskIds = new Set([input.taskId]);
				}
				if (input.objectiveId) {
					const objective = objectives.find((item) => item.id === input.objectiveId);
					if (!objective)
						throw new TRPCError({ code: "NOT_FOUND", message: "Objective is not recorded in this project." });
					objectives = [objective];
					taskIds = new Set(objective.tasks.map((task) => task.taskId));
					attachedAfter = new Map(objective.tasks.map((task) => [task.taskId, Date.parse(task.attachedAt)]));
					scope = "objective";
				}
				if (input.planTaskId) {
					const plan = (await deps.plans.read(workspaceId)).plans[input.planTaskId];
					if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "Plan is not recorded in this project." });
					taskIds = new Set([
						...Object.values(plan.expansion?.cards ?? {}),
						...(await deps.contexts.bindings(workspaceId))
							.filter((binding) => binding.planTaskId === input.planTaskId)
							.map((binding) => binding.taskId),
					]);
					scope = "plan";
				}
				return buildEfficiencyReport({
					objectives,
					timing,
					taskIds,
					scope,
					attachedAfter,
					now: (deps.now ?? Date.now)(),
				});
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Efficiency report sources are unavailable or damaged; no unknown value was converted to zero and no workflow was changed.",
				});
			}
		},
	};
}
