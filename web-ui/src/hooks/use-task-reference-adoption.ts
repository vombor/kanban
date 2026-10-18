import { useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useAsync } from "@/utils/react-use";
import { receiptRequestId } from "@/utils/receipt-request-id";

type Input = Parameters<ReturnType<typeof getRuntimeTrpcClient>["taskKnowledge"]["adopt"]["mutate"]>[0];
/** User clicks alone enqueue a mutation. A failed/uncertain exact retry keeps its receipt id. */
export function useTaskReferenceAdoption(workspaceId: string | null) {
	const [attempt, setAttempt] = useState<{ workspaceId: string; input: Input } | null>(null);
	const receipt = useRef<{ fingerprint: string; input: Input } | null>(null);
	const result = useAsync(
		async () =>
			attempt ? getRuntimeTrpcClient(attempt.workspaceId).taskKnowledge.adopt.mutate(attempt.input) : null,
		[attempt],
	);
	const submit = (input: Omit<Input, "requestId">) => {
		if (!workspaceId) return;
		const fingerprint = `${workspaceId}:${JSON.stringify(input)}`;
		if (receipt.current?.fingerprint !== fingerprint)
			receipt.current = { fingerprint, input: { ...input, requestId: receiptRequestId() } };
		setAttempt({ workspaceId, input: receipt.current.input });
	};
	return { submit, result, isSubmitting: Boolean(attempt && result.loading) };
}
