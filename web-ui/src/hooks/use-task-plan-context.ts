import { useCallback, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

type Client = ReturnType<typeof getRuntimeTrpcClient>;
type ReadInput = Parameters<Client["taskKnowledge"]["read"]["query"]>[0];
export function useTaskPlanContext(workspaceId: string | null, taskId: string, open: boolean) {
	const [selected, setSelected] = useState<Pick<
		ReadInput,
		"part" | "id" | "offset" | "contextRevision" | "attemptId"
	> | null>(null);
	const queryFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).taskKnowledge.get.query({ taskId }),
		[workspaceId, taskId],
	);
	const query = useTrpcQuery({ enabled: open && Boolean(workspaceId), queryFn });
	const contextRevision = query.data?.context?.revision;
	const readFn = useCallback(async () => {
		if (!selected || !contextRevision) throw new Error("Select a retained plan part first.");
		return getRuntimeTrpcClient(workspaceId).taskKnowledge.read.query({
			taskId,
			contextRevision,
			...selected,
			limit: 4096,
		});
	}, [workspaceId, taskId, contextRevision, selected]);
	const read = useTrpcQuery({ enabled: open && Boolean(contextRevision) && Boolean(selected), queryFn: readFn });
	const select = useCallback(
		(value: Pick<ReadInput, "part" | "id" | "offset" | "contextRevision" | "attemptId"> | null) => {
			read.setData(null);
			setSelected(value);
		},
		[read.setData],
	);
	const reset = useCallback(() => select(null), [select]);
	return { query, read, selected, select, reset };
}
