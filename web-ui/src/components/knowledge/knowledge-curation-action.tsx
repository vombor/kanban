import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useKnowledgeMutation } from "@/hooks/use-knowledge-mutation";
import type { getRuntimeTrpcClient } from "@/runtime/trpc-client";

type Mutation = Parameters<ReturnType<typeof getRuntimeTrpcClient>["knowledge"]["mutate"]["mutate"]>[0];
type Action =
	| Omit<Extract<Mutation, { action: "pin" }>, "requestId">
	| Omit<Extract<Mutation, { action: "review" }>, "requestId">;
/** No mutation on mount/open/read. Confirmation is specific to the displayed immutable revisions. */
export function KnowledgeCurationAction({
	workspaceId,
	action,
	label,
	onConfirmed,
}: {
	workspaceId: string;
	action: Action;
	label: string;
	onConfirmed: () => void;
}) {
	const [confirm, setConfirm] = useState(false);
	const mutation = useKnowledgeMutation(workspaceId, onConfirmed);
	return (
		<div className="space-y-2">
			{!confirm ? (
				<Button size="sm" onClick={() => setConfirm(true)}>
					{label}
				</Button>
			) : (
				<div className="space-y-2 rounded-md border border-border-bright p-2">
					<p className="break-all text-xs text-text-secondary">
						{label}? Expected current revision: {action.expectedRevision ?? "no published document"}. This curates
						reference material only, never approves execution or changes a task's pins.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="primary"
							disabled={mutation.busy || mutation.retry}
							onClick={() => mutation.submit(action)}
						>
							Confirm {label.toLowerCase()}
						</Button>
						<Button size="sm" disabled={mutation.busy || mutation.retry} onClick={() => setConfirm(false)}>
							Cancel
						</Button>
					</div>
				</div>
			)}
			{mutation.error ? (
				<p role="alert" className="text-xs text-status-red">
					{mutation.error}
				</p>
			) : null}
			{mutation.retry ? (
				<Button size="sm" disabled={mutation.busy} onClick={mutation.retryExact}>
					Retry exact curation change
				</Button>
			) : null}
		</div>
	);
}
