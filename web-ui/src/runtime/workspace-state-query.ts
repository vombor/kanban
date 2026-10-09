import { TRPCClientError } from "@trpc/client";
import { createWorkspaceTrpcClient, readTrpcConflictRevision } from "@/runtime/trpc-client";
import type {
	RuntimeOrchestratorWaitDetail,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
} from "@/runtime/types";

export class WorkspaceStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(currentRevision: number, message = "Workspace state revision conflict.") {
		super(message);
		this.name = "WorkspaceStateConflictError";
		this.currentRevision = currentRevision;
	}
}

export async function fetchWorkspaceState(workspaceId: string): Promise<RuntimeWorkspaceStateResponse> {
	const trpcClient = createWorkspaceTrpcClient(workspaceId);
	return await trpcClient.workspace.getState.query();
}

/** What the project's orchestrator asks the user, or null when it waits for nothing. */
export async function fetchOrchestratorWait(workspaceId: string): Promise<RuntimeOrchestratorWaitDetail | null> {
	const trpcClient = createWorkspaceTrpcClient(workspaceId);
	return (await trpcClient.workspace.getOrchestratorWait.query()).wait;
}

export async function saveWorkspaceState(
	workspaceId: string,
	payload: RuntimeWorkspaceStateSaveRequest,
): Promise<RuntimeWorkspaceStateResponse> {
	const trpcClient = createWorkspaceTrpcClient(workspaceId);
	try {
		return await trpcClient.workspace.saveState.mutate(payload);
	} catch (error) {
		if (error instanceof TRPCClientError) {
			const conflictRevision = readTrpcConflictRevision(error);
			if (typeof conflictRevision === "number") {
				throw new WorkspaceStateConflictError(conflictRevision, error.message);
			}
		}
		throw error;
	}
}
