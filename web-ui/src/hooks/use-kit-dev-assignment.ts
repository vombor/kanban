import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId, RuntimeDevAssignmentResponse, RuntimeTaskAgentSettings } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export type KitDevAssignmentProposal = NonNullable<RuntimeDevAssignmentResponse["proposal"]>;

interface WorkspaceDevAssignment {
	workspaceId: string;
	response: RuntimeDevAssignmentResponse;
}

/**
 * The project's routing-kit proposal for a new card (the runtime's src/kits/dev-assignment.ts), loaded each time the
 * create dialog opens so `kanban kit apply` takes effect without a reload. Null while loading, on error (an older
 * runtime), or when the answer belongs to another project.
 */
export function useKitDevAssignment(
	workspaceId: string | null,
	isCreateOpen: boolean,
): RuntimeDevAssignmentResponse | null {
	const queryFn = useCallback(async (): Promise<WorkspaceDevAssignment> => {
		if (!workspaceId) {
			throw new Error("No project selected.");
		}
		const response = await getRuntimeTrpcClient(workspaceId).workspace.getDevAssignment.query();
		return { workspaceId, response };
	}, [workspaceId]);
	const query = useTrpcQuery<WorkspaceDevAssignment>({ enabled: Boolean(workspaceId) && isCreateOpen, queryFn });
	return query.data && query.data.workspaceId === workspaceId ? query.data.response : null;
}

/** The proposal the create dialog preselects: only an `applied` one (a shadow proposal is shown, never applied). */
export function getPreselectedKitProposal(
	devAssignment: RuntimeDevAssignmentResponse | null,
): KitDevAssignmentProposal | null {
	return devAssignment?.outcome === "applied" ? devAssignment.proposal : null;
}

/** True while the dialog's agent and model are still exactly the kit's proposal. */
export function isKitProposalSelected(
	proposal: KitDevAssignmentProposal,
	agentId: RuntimeAgentId | undefined,
	agentSettings: RuntimeTaskAgentSettings | undefined,
): boolean {
	return (
		agentId === proposal.agentId &&
		agentSettings?.modelId === proposal.agentSettings?.modelId &&
		agentSettings?.providerId === proposal.agentSettings?.providerId
	);
}
