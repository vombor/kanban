import { useCallback, useState } from "react";

import type { RuntimePipelineCardStage } from "@/runtime/types";
import { getPipelineCardStage } from "@/stores/pipeline-card-stage-store";
import type { BoardCard } from "@/types";

export interface PendingApproveAndLand {
	taskId: string;
	taskTitle: string;
	stage: RuntimePipelineCardStage;
}

/**
 * Approve & land, asked first while the pipeline has the card's checks or QA in flight (its card stage's `inFlight`,
 * issue #30). Otherwise it lands at once, as before.
 */
export function useApproveAndLandConfirmation(approveAndLandTask: (taskId: string) => Promise<void>): {
	pendingApproveAndLand: PendingApproveAndLand | null;
	requestApproveAndLand: (card: BoardCard) => void;
	resolveApproveAndLand: (land: boolean) => void;
} {
	const [pendingApproveAndLand, setPendingApproveAndLand] = useState<PendingApproveAndLand | null>(null);

	const requestApproveAndLand = useCallback(
		(card: BoardCard) => {
			const stage = getPipelineCardStage(card.id);
			if (stage?.inFlight) {
				setPendingApproveAndLand({ taskId: card.id, taskTitle: card.title || card.id, stage });
				return;
			}
			void approveAndLandTask(card.id);
		},
		[approveAndLandTask],
	);

	const resolveApproveAndLand = useCallback(
		(land: boolean) => {
			const pending = pendingApproveAndLand;
			setPendingApproveAndLand(null);
			if (pending && land) {
				void approveAndLandTask(pending.taskId);
			}
		},
		[approveAndLandTask, pendingApproveAndLand],
	);

	return { pendingApproveAndLand, requestApproveAndLand, resolveApproveAndLand };
}
