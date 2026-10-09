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

/**
 * Whether the dialog's agent and model are among the combinations the project may route dev work to (the runtime's
 * vetted model registry). True when the project's kit routes nothing (no list). Providers count only where both
 * sides name one, as in the runtime's lookup.
 */
export function isVettedDevSelection(
	devAssignment: RuntimeDevAssignmentResponse | null,
	agentId: RuntimeAgentId | undefined,
	agentSettings: RuntimeTaskAgentSettings | undefined,
): boolean {
	const vetted = devAssignment?.vettedDev;
	if (!vetted || !agentId) {
		return true;
	}
	const modelId = agentSettings?.modelId?.trim() || null;
	const providerId = agentSettings?.providerId?.trim() || null;
	return vetted.some(
		(entry) =>
			entry.agentId === agentId &&
			entry.modelId === modelId &&
			(entry.providerId === null || providerId === null || entry.providerId === providerId),
	);
}
