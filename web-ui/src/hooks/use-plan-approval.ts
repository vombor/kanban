import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

type RuntimeClient = ReturnType<typeof getRuntimeTrpcClient>;
export type PlanApprovalPreview = NonNullable<Awaited<ReturnType<RuntimeClient["plans"]["preview"]["query"]>>["plan"]>;

export type PlanApprovalStep = { kind: "confirm" } | { kind: "approved" };

export interface PlanApprovalState {
	preview: PlanApprovalPreview | null;
	isLoadingPreview: boolean;
	step: PlanApprovalStep;
	isSubmitting: boolean;
	error: string | null;
	approve: () => Promise<void>;
	reset: () => void;
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A plan card's approval from the board (the runtime's src/trpc/plans-api.ts): loads what would be approved while the
 * confirmation dialog is open, then asks the runtime to record the approval of exactly that breakdown. The runtime
 * refuses agent sessions; the user is approved at once.
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
			if (response.ok && response.approval) {
				setStep({ kind: "approved" });
			} else {
				setError(response.error ?? "The plan was not approved.");
			}
		} catch (caught) {
			setError(toMessage(caught));
		} finally {
			setIsSubmitting(false);
		}
	}, [preview, taskId, workspaceId]);

	return {
		preview,
		isLoadingPreview: previewQuery.isLoading,
		step,
		isSubmitting,
		error: error ?? (previewQuery.error ? previewQuery.error.message : null),
		approve,
		reset,
	};
}
