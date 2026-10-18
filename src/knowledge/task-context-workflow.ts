import { lockedFileSystem } from "../fs/locked-file-system";
import {
	type KnowledgeAttempt,
	type KnowledgeSource,
	knowledgeAttemptSchema,
	type TaskKnowledgeContext,
	taskKnowledgeContextSchema,
} from "../trpc/knowledge-execution-contract";
import { hashKnowledgeContent } from "./content-store";
import { KnowledgeError } from "./knowledge-error";
import { type TaskContextState, taskContextDigest, writeTaskContextState } from "./task-context-state";

export function inheritTaskContext(
	state: TaskContextState,
	taskId: string,
	source: KnowledgeSource,
	at: string,
): TaskKnowledgeContext | null {
	const sourceContext = state.tasks[source.sourceTaskId]?.at(-1);
	if (!sourceContext) return null;
	if (taskId === source.sourceTaskId) throw new KnowledgeError("CONFLICT", "A task cannot inherit its own context.");
	const existing = state.tasks[taskId]?.[0];
	if (existing) {
		if (
			existing.inheritance?.sourceTaskId !== source.sourceTaskId ||
			existing.inheritance.kind !== source.kind ||
			existing.inheritance.snapshot !== source.snapshot
		)
			throw new KnowledgeError(
				"CONFLICT",
				"This target already retains a different handoff; no context was replaced.",
			);
		return existing; // Exact original attachment stays fixed even if its unstarted source later adopts another ref.
	}
	const definition = {
		version: 1 as const,
		taskId,
		planTaskId: sourceContext.planTaskId,
		bundleRevision: sourceContext.bundleRevision,
		documents: sourceContext.documents,
		inheritance: { ...source, sourceContextRevision: sourceContext.revision },
	};
	const context = taskKnowledgeContextSchema.parse({
		...definition,
		revision: taskContextDigest(definition),
		attachedAt: at,
	});
	state.tasks[taskId] = [context];
	return context;
}
export interface ReserveKnowledgeAttempt {
	taskId: string;
	requestId: string;
	kind: KnowledgeAttempt["kind"];
	snapshot?: string;
	round?: number;
}
export function createKnowledgeAttemptStore(deps: {
	file: (workspaceId: string) => string;
	snapshot: (workspaceId: string) => Promise<TaskContextState>;
	inspect: (
		workspaceId: string,
		taskId: string,
		state: TaskContextState,
	) => Promise<{ context: TaskKnowledgeContext | null; history: TaskKnowledgeContext[] }>;
	now: () => Date;
}) {
	return {
		reserve: async (workspaceId: string, input: ReserveKnowledgeAttempt, rootRevision?: string) =>
			lockedFileSystem.withLock({ path: deps.file(workspaceId) }, async () => {
				const state = await deps.snapshot(workspaceId),
					view = await deps.inspect(workspaceId, input.taskId, state);
				if (rootRevision && view.history[0]?.revision !== rootRevision)
					throw new KnowledgeError(
						"PRECONDITION_FAILED",
						"The card's retained knowledge attachment is missing or mismatched; no unpinned launch is permitted.",
					);
				if (!view.context) return null;
				const id = hashKnowledgeContent(
					JSON.stringify({ taskId: input.taskId, kind: input.kind, requestId: input.requestId }),
				);
				state.attempts ??= {};
				const history = state.attempts[input.taskId] ?? [],
					existing = history.find((attempt) => attempt.id === id);
				if (existing) {
					if (
						existing.snapshot !== input.snapshot ||
						existing.round !== input.round ||
						existing.contextRevision !== view.context.revision
					)
						throw new KnowledgeError("CONFLICT", "Knowledge attempt identity was reused for different context.");
					if (input.kind === "session")
						throw new KnowledgeError(
							"CONFLICT",
							"A physical knowledge attempt is already reserved; inspect its outcome instead of replaying it.",
						);
					return { context: view.context, attempt: existing };
				}
				const at = deps.now().toISOString();
				state.starts ??= {};
				state.starts[input.taskId] ??= { contextRevision: view.context.revision, at };
				const attempt = knowledgeAttemptSchema.parse({
					id,
					taskId: input.taskId,
					contextRevision: view.context.revision,
					kind: input.kind,
					reservedAt: at,
					outcome: "reserved",
					startedAt: null,
					...(input.snapshot ? { snapshot: input.snapshot } : {}),
					...(input.round !== undefined ? { round: input.round } : {}),
				});
				state.attempts[input.taskId] = [...history, attempt];
				await writeTaskContextState(deps.file(workspaceId), state);
				return { context: view.context, attempt };
			}),
		settle: async (
			workspaceId: string,
			taskId: string,
			id: string,
			outcome: "started" | "uncertain",
			startedAt: number | null,
		) =>
			lockedFileSystem.withLock({ path: deps.file(workspaceId) }, async () => {
				const state = await deps.snapshot(workspaceId),
					attempt = state.attempts?.[taskId]?.find((item) => item.id === id);
				if (!attempt || attempt.kind !== "session")
					throw new KnowledgeError("NOT_FOUND", "No physical knowledge attempt matches that outcome.");
				if (attempt.outcome !== "reserved") {
					if (attempt.outcome === outcome && attempt.startedAt === startedAt) return;
					throw new KnowledgeError("CONFLICT", "Retained attempt outcome cannot be rewritten.");
				}
				attempt.outcome = outcome;
				attempt.startedAt = startedAt;
				await writeTaskContextState(deps.file(workspaceId), state);
			}),
	};
}
