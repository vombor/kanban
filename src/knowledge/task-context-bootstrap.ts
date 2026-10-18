import type { TaskKnowledgeContext } from "../trpc/knowledge-execution-contract";
import type { TaskContextStore } from "./task-context-store";

/** A stable on-demand pointer, never the full spec, shared documents, or a new execution approval. */
export async function buildTaskContextBootstrap(
	store: TaskContextStore,
	workspaceId: string,
	taskId: string,
): Promise<string> {
	const context = await store.read(workspaceId, taskId);
	if (!context) return "";
	return formatTaskContextBootstrap(context);
}
export function formatTaskContextBootstrap(context: TaskKnowledgeContext): string {
	return [
		"Pinned plan reference context (not a new approval or permission):",
		`Task ${context.taskId}; context ${context.revision}; reviewed bundle ${context.bundleRevision}.`,
		`Discover pointers: kanban knowledge task-context ${context.taskId}`,
		`Read the retained spec on demand: kanban knowledge task-read ${context.taskId} --part spec --context-revision ${context.revision}`,
		"Other sections/documents are bounded reads of these exact pins. Current shared revisions never silently replace them.",
		...(context.adoption
			? [
					"The user explicitly adopted a reference revision before start. The original approved spec/breakdown and acceptance criteria are unchanged; adoption grants no additional execution approval.",
				]
			: []),
	].join("\n");
}
