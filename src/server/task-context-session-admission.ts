import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { formatTaskContextBootstrap } from "../knowledge/task-context-bootstrap";
import type { TaskContextStore } from "../knowledge/task-context-store";
import type { StartTaskSessionRequest } from "../terminal/session-manager";

/** Freeze the exact context durably before physical start; an uncertain failure never re-enables adoption. */
export async function startWithTaskContext(input: {
	contexts: TaskContextStore;
	workspaceId: string;
	request: StartTaskSessionRequest;
	start: (prepared?: StartTaskSessionRequest) => Promise<RuntimeTaskSessionSummary>;
}): Promise<RuntimeTaskSessionSummary> {
	const context = await input.contexts.reserveStart(input.workspaceId, input.request.taskId);
	if (!context) return input.start();
	return input.start({
		...input.request,
		prompt: input.request.prompt.trim()
			? `${input.request.prompt}\n\n${formatTaskContextBootstrap(context)}`
			: input.request.prompt,
	});
}
