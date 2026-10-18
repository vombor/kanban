import type { RuntimeAppRouter } from "@runtime-trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useKnowledgeQuery } from "./use-knowledge-query";

export function useKnowledgeProposal(workspaceId: string, id: string, offset: number) {
	const queryFn = useCallback(async () => {
		const client = getRuntimeTrpcClient(workspaceId);
		const proposal = await client.knowledge.proposalRead.query({ id, offset, limit: 4096 });
		const documentId = proposal.proposal.document.id;
		const current = await client.knowledge.read
			.query({ id: documentId, offset, limit: 4096 })
			.catch((error: unknown) => {
				if (
					error instanceof TRPCClientError &&
					(error as TRPCClientError<RuntimeAppRouter>).data?.code === "NOT_FOUND"
				)
					return null;
				throw error;
			});
		const base = proposal.proposal.baseRevision
			? await client.knowledge.read.query({
					id: documentId,
					revision: proposal.proposal.baseRevision,
					offset,
					limit: 4096,
				})
			: null;
		return { ...proposal, current, base };
	}, [workspaceId, id, offset]);
	return useKnowledgeQuery(JSON.stringify([workspaceId, id, offset]), queryFn);
}
