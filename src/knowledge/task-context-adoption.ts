import type { KnowledgeDocument } from "../trpc/knowledge-contract";
import { type TaskContextAdoptRequest, taskKnowledgeContextSchema } from "../trpc/knowledge-execution-contract";
import { KnowledgeError } from "./knowledge-error";
import { type TaskContextState, taskContextDigest } from "./task-context-state";

/** Exact retries return their retained receipt, not a second mutation or a rollback to that historical context. */
export function findTaskContextAdoption(state: TaskContextState, input: TaskContextAdoptRequest) {
	for (const history of Object.values(state.tasks))
		for (const context of history) {
			const adoption = context.adoption;
			if (adoption?.requestId !== input.requestId) continue;
			if (
				context.taskId !== input.taskId ||
				adoption.parentRevision !== input.expectedContextRevision ||
				adoption.documentId !== input.documentId ||
				adoption.previousRevision !== input.expectedDocumentRevision ||
				adoption.targetRevision !== input.targetRevision ||
				adoption.reason !== input.reason
			)
				throw new KnowledgeError("CONFLICT", "That adoption request id already records another user choice.");
			return context;
		}
	return null;
}
export function applyTaskContextAdoption(
	state: TaskContextState,
	input: TaskContextAdoptRequest,
	document: KnowledgeDocument,
	at: string,
) {
	const history = state.tasks[input.taskId],
		previous = history?.at(-1);
	if (!previous || !history)
		throw new KnowledgeError("NOT_FOUND", "This task has no reviewed-plan handoff to adopt into.");
	if (state.starts?.[input.taskId])
		throw new KnowledgeError(
			"PRECONDITION_FAILED",
			"A physical start was reserved; this task's reference context is frozen, even if that start failed or is uncertain.",
		);
	if (previous.revision !== input.expectedContextRevision)
		throw new KnowledgeError("CONFLICT", "Task context changed since it was reviewed; no revision was adopted.");
	const original = previous.documents.find((item) => item.id === input.documentId);
	if (
		!original ||
		original.revision !== input.expectedDocumentRevision ||
		document.id !== original.id ||
		document.revision !== input.targetRevision
	)
		throw new KnowledgeError(
			"CONFLICT",
			"Adoption must name the exact existing pinned document and its reviewed replacement revision.",
		);
	if (document.revision === original.revision)
		throw new KnowledgeError("BAD_REQUEST", "That reference revision is already pinned; nothing was adopted.");
	const definition = {
		version: 1 as const,
		taskId: previous.taskId,
		planTaskId: previous.planTaskId,
		bundleRevision: previous.bundleRevision,
		...(previous.inheritance ? { inheritance: previous.inheritance } : {}),
		documents: previous.documents.map((item) => (item.id === document.id ? document : item)),
		adoption: {
			requestId: input.requestId,
			parentRevision: previous.revision,
			documentId: input.documentId,
			previousRevision: original.revision,
			targetRevision: document.revision,
			reason: input.reason,
			by: "user" as const,
			at,
		},
	};
	const context = taskKnowledgeContextSchema.parse({
		...definition,
		revision: taskContextDigest(definition),
		attachedAt: at,
	});
	history.push(context);
	return context;
}
