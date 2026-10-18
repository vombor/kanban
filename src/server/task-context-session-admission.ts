import { randomUUID } from "node:crypto";
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
	rootRevision?: string;
}): Promise<RuntimeTaskSessionSummary> {
	const reservation = await input.contexts.reserveAttempt(
		input.workspaceId,
		{ taskId: input.request.taskId, requestId: input.request.admissionId ?? randomUUID(), kind: "session" },
		input.rootRevision,
	);
	if (!reservation) return input.start();
	try {
		const summary = await input.start({
			...input.request,
			prompt: input.request.prompt.trim()
				? `${input.request.prompt}\n\n${formatTaskContextBootstrap(reservation.context)}\nRetained physical attempt ${reservation.attempt.id}. Read exact references with: kanban knowledge task-read ${input.request.taskId} --part spec --attempt-id ${reservation.attempt.id}`
				: input.request.prompt,
		});
		if (summary.taskId !== input.request.taskId || summary.startedAt === null || !Number.isFinite(summary.startedAt))
			throw new Error(
				"Physical session identity/start clock could not be verified; retained context attempt remains uncertain.",
			);
		await input.contexts.settleAttempt(
			input.workspaceId,
			input.request.taskId,
			reservation.attempt.id,
			"started",
			summary.startedAt,
		);
		return summary;
	} catch (error) {
		await input.contexts
			.settleAttempt(input.workspaceId, input.request.taskId, reservation.attempt.id, "uncertain", null)
			.catch(() => {});
		throw error;
	}
}
