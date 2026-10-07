import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

type RuntimeClient = ReturnType<typeof getRuntimeTrpcClient>;
export type PlanApprovalPreview = NonNullable<Awaited<ReturnType<RuntimeClient["plans"]["preview"]["query"]>>["plan"]>;

export type PlanApprovalStep =
	| { kind: "confirm" }
	/** The server holds the approval until the user enters the code it printed on its console. */
	| { kind: "code"; approvalId: string }
	| { kind: "approved" };

export interface PlanApprovalState {
	preview: PlanApprovalPreview | null;
	isLoadingPreview: boolean;
	step: PlanApprovalStep;
	isSubmitting: boolean;
	error: string | null;
	approve: () => Promise<void>;
	submitCode: (code: string) => Promise<void>;
	reset: () => void;
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A plan card's approval from the board (the runtime's src/trpc/plans-api.ts): loads what would be approved while the
 * dialog is open, then asks the runtime. A passcode-authenticated browser is approved at once; otherwise the runtime
 * prints a one-time code on its console and the user enters it here (as `kanban plan approve` asks on the terminal).
 */
export function usePlanApproval(workspaceId: string | null, taskId: string, isOpen: boolean): PlanApprovalState {
	const [step, setStep] = useState<PlanApprovalStep>({ kind: "confirm" });
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const queryFn = useCallback(async (): Promise<PlanApprovalPreview> => {
		const response = await getRuntimeTrpcClient(workspaceId).plans.preview.query({ taskId });
		if (!response.ok || !response.plan) {
			throw new Error(response.error ?? "The plan can't be approved now.");
		}
		return response.plan;
	}, [taskId, workspaceId]);
	const previewQuery = useTrpcQuery<PlanApprovalPreview>({ enabled: isOpen && Boolean(workspaceId), queryFn });
	const preview = previewQuery.data;

	const reset = useCallback(() => {
		setStep({ kind: "confirm" });
		setError(null);
		setIsSubmitting(false);
	}, []);

	const approve = useCallback(async () => {
		if (!preview) {
			return;
		}
		setIsSubmitting(true);
		setError(null);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).plans.approve.mutate({
				taskId,
				via: "approve",
				breakdownSha256: preview.breakdownSha256,
			});
			if (!response.ok) {
				setError(response.error ?? "The plan was not approved.");
			} else if (response.approval) {
				setStep({ kind: "approved" });
			} else if (response.approvalId) {
				setStep({ kind: "code", approvalId: response.approvalId });
			} else {
				setError("The runtime neither approved the plan nor asked for a code.");
			}
		} catch (caught) {
			setError(toMessage(caught));
		} finally {
			setIsSubmitting(false);
		}
	}, [preview, taskId, workspaceId]);

	const submitCode = useCallback(
		async (code: string) => {
			if (step.kind !== "code" || !code.trim()) {
				return;
			}
			setIsSubmitting(true);
			setError(null);
			try {
				const client = getRuntimeTrpcClient(workspaceId);
				const result = await client.isolation.approve.mutate({ id: step.approvalId, code: code.trim() });
				if (result.ok) {
					setStep({ kind: "approved" });
					return;
				}
				const status = await client.isolation.approvalStatus.query({ id: step.approvalId });
				if (status.approval?.status !== "pending") {
					// Too many wrong codes, expired, or Kanban restarted: start over with a new code.
					setStep({ kind: "confirm" });
				}
				setError(result.error ?? "The code was not accepted.");
			} catch (caught) {
				setError(toMessage(caught));
			} finally {
				setIsSubmitting(false);
			}
		},
		[step, workspaceId],
	);

	return {
		preview,
		isLoadingPreview: previewQuery.isLoading,
		step,
		isSubmitting,
		error: error ?? (previewQuery.error ? previewQuery.error.message : null),
		approve,
		submitCode,
		reset,
	};
}
