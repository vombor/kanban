import { TRPCError } from "@trpc/server";
import type { RuntimeCaller } from "../isolation/session-identity";
import type { RuntimeObjectiveApi } from "../trpc/objective-contract";
import { decideObjectiveAdmission } from "./objective-admission";
import { describeObjectiveHandoff } from "./objective-handoff";
import { createObjectiveStore, ObjectiveError, type ObjectiveStore } from "./objective-store";

export function authorizeObjectiveCaller(caller: RuntimeCaller, workspaceId: string, write = false): void {
	if (caller.kind === "user") return;
	if (!write && caller.kind === "session" && caller.session.workspaceId === workspaceId) return;
	throw new TRPCError({
		code: "FORBIDDEN",
		message: write
			? "Objective requirements, policy and limits are user-owned; agents cannot approve or raise them."
			: "Objective data belongs only to the user and that project's identified sessions.",
	});
}

export function createObjectiveApi(options: {
	store?: ObjectiveStore;
	taskIds: (workspaceId: string) => Promise<ReadonlySet<string>>;
	recheck?: (workspaceId: string) => Promise<void>;
	admissionScopeAvailable?: boolean;
	now?: () => number;
	taskEligibility?: (workspaceId: string) => Promise<{ known: ReadonlySet<string>; unstarted: ReadonlySet<string> }>;
}): RuntimeObjectiveApi {
	const store = options.store ?? createObjectiveStore();
	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ObjectiveError) throw new TRPCError({ code: error.code, message: error.message });
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Objective data could not be read or changed; preserve evidence and inspect storage before retrying.",
			});
		}
	};
	const readObjective = async (workspaceId: string, id: string) => {
		const objective = (await store.read(workspaceId)).objectives.find((item) => item.id === id);
		if (!objective) throw new ObjectiveError("NOT_FOUND", "Objective not found.");
		const guide = describeObjectiveHandoff(objective, workspaceId);
		return {
			objective,
			requirements: await store.readRequirements(workspaceId, objective.requirementsHash),
			handoffGuide: guide
				? { ...guide, executionEnforcementAvailable: options.admissionScopeAvailable === true }
				: null,
			admissionScopeAvailable: options.admissionScopeAvailable === true,
			admissionStates: objective.tasks.flatMap((task) =>
				(["start", "input"] as const).map((kind) => {
					const decision = decideObjectiveAdmission(
						objective,
						task.taskId,
						kind,
						(options.now ?? Date.now)(),
						options.admissionScopeAvailable === true,
					);
					return { taskId: task.taskId, kind, allowed: decision.allowed, reason: decision.reason };
				}),
			),
		};
	};
	return {
		manualLineage: async (caller, workspaceId, input) => {
			authorizeObjectiveCaller(caller, workspaceId, true);
			return run(async () => {
				if ((await store.read(workspaceId)).receipts.some((row) => row.requestId === input.requestId))
					return store.manualLineage(workspaceId, input);
				const eligibility = options.taskEligibility
					? await options.taskEligibility(workspaceId)
					: { known: await options.taskIds(workspaceId), unstarted: new Set<string>() };
				if (
					input.taskIds.some((id) => (input.planned ? eligibility.known.has(id) : !eligibility.unstarted.has(id)))
				)
					throw new ObjectiveError(
						"BAD_REQUEST",
						"Planned task ids must be new; existing links must be unstarted Backlog dev tasks. No historical acceptance or execution approval is adopted.",
					);
				return store.manualLineage(workspaceId, input);
			});
		},
		control: async (caller, workspaceId, input) => {
			authorizeObjectiveCaller(caller, workspaceId, true);
			return run(async () => store.control(workspaceId, input));
		},
		list: async (caller, workspaceId, input) => {
			authorizeObjectiveCaller(caller, workspaceId);
			return await run(async () => {
				const state = await store.read(workspaceId);
				const end = input.offset + input.limit;
				await Promise.all(
					state.objectives
						.slice(input.offset, end)
						.map((objective) => store.readRequirements(workspaceId, objective.requirementsHash)),
				);
				return {
					objectives: state.objectives.slice(input.offset, end),
					total: state.objectives.length,
					nextOffset: end < state.objectives.length ? end : null,
				};
			});
		},
		read: async (caller, workspaceId, id) => {
			authorizeObjectiveCaller(caller, workspaceId);
			return await run(async () => await readObjective(workspaceId, id));
		},
		recheck: async (caller, workspaceId, id) => {
			authorizeObjectiveCaller(caller, workspaceId, true);
			return await run(async () => {
				await readObjective(workspaceId, id);
				if (!options.recheck)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Native objective reconciliation is unavailable; no task execution was requested.",
					);
				await options.recheck(workspaceId);
				return await readObjective(workspaceId, id);
			});
		},
		create: async (caller, workspaceId, input) => {
			authorizeObjectiveCaller(caller, workspaceId, true);
			if (input.limits.mode === "enforce" && (!options.admissionScopeAvailable || !input.acknowledgeAdmissionScope))
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Objective opt-in enforcement needs supported Kanban-admission scope and explicit boundary acknowledgement; report mode only without it.",
				});
			return await run(async () => {
				const ids = await options.taskIds(workspaceId);
				if (input.taskIds.some((id) => !ids.has(id)))
					throw new ObjectiveError(
						"BAD_REQUEST",
						"Every objective task must belong to this project's current board.",
					);
				return await store.create(workspaceId, input);
			});
		},
		setLimits: async (caller, workspaceId, input) => {
			authorizeObjectiveCaller(caller, workspaceId, true);
			if (input.limits.mode === "enforce" && (!options.admissionScopeAvailable || !input.acknowledgeAdmissionScope))
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Objective opt-in enforcement needs supported Kanban-admission scope and explicit boundary acknowledgement; report mode only without it.",
				});
			return await run(async () => await store.setLimits(workspaceId, input));
		},
	};
}
