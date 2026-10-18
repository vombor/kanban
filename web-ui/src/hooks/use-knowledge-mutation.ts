import { useEffect, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { receiptRequestId } from "@/utils/receipt-request-id";

type Input = Parameters<ReturnType<typeof getRuntimeTrpcClient>["knowledge"]["mutate"]["mutate"]>[0];
/** Exact user-triggered retry only; changing scope discards the view, never redirects the pending mutation. */
export function useKnowledgeMutation(workspaceId: string, onConfirmed: () => void) {
	const scope = useRef<{
		workspaceId: string;
		alive: boolean;
		writing: boolean;
		pending: { workspaceId: string; input: Input } | null;
	}>({ workspaceId, alive: false, writing: false, pending: null });
	if (scope.current.workspaceId !== workspaceId)
		scope.current = { workspaceId, alive: false, writing: false, pending: null };
	const token = scope.current;
	const [state, setState] = useState({ token, busy: false, retry: false, error: "" });
	useEffect(() => {
		token.alive = true;
		return () => {
			token.alive = false;
		};
	}, [token]);
	const current = () => scope.current === token && token.alive;
	const run = async (operation: { workspaceId: string; input: Input }) => {
		if (token.writing || !current()) return;
		token.writing = true;
		token.pending = operation;
		setState({ token, busy: true, retry: false, error: "" });
		try {
			await getRuntimeTrpcClient(operation.workspaceId).knowledge.mutate.mutate(operation.input);
			if (current()) {
				token.pending = null;
				setState({ token, busy: false, retry: false, error: "" });
				onConfirmed();
			}
		} catch {
			if (current())
				setState({
					token,
					busy: false,
					retry: true,
					error: "The curation change was refused or could not be confirmed. Reload retained state before changing the request; exact retry keeps its original identity and revisions.",
				});
		} finally {
			token.writing = false;
		}
	};
	const submit = (
		input:
			| Omit<Extract<Input, { action: "pin" }>, "requestId">
			| Omit<Extract<Input, { action: "review" }>, "requestId">,
	) => {
		if (token.pending || token.writing) return;
		void run({ workspaceId, input: { ...input, requestId: receiptRequestId() } });
	};
	return {
		...(state.token === token ? state : { busy: false, retry: false, error: "" }),
		submit,
		retryExact: () => {
			if (token.pending) void run(token.pending);
		},
	};
}
