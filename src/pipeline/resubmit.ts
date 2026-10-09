// `kanban task resubmit`: the supported way to have a Review dev card snapshotted and sent to the QA gate again
// (issue #20: f0ba7 sat in Review for 2.5 h with real work after an early "no changes" snapshot, and nothing on the
// CLI could retrigger it; `task start` only starts Backlog and In Progress cards).
//
// The request is a record on the card's pipeline-state entry (`resubmit`), written under the state's file lock by
// the server's route (src/trpc/pipeline-resubmit-api.ts). The submission stage keys its cached inspection on it, so
// the next evaluation takes a new snapshot (with its checks) and the engine asks the QA gate as for any submission:
// a snapshot with changes gets QA, one without is recorded as `emptyDiff` again. Nothing else reads it, and it is
// never removed: a later request replaces it.
import type { PipelineCardState, PipelineStateStore } from "./pipeline-state";

/** The pipeline-state field the resubmit route writes. */
export const RESUBMIT_FIELD = "resubmit";

export interface ResubmitRequest {
	/** ISO time of the request. */
	at: string;
	/** Who asked: "user" or "orchestrator <taskId>". */
	by: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The card's last resubmit request, or null. */
export function readResubmitRequest(entry: PipelineCardState | undefined): ResubmitRequest | null {
	const value = entry?.[RESUBMIT_FIELD];
	if (!isRecord(value) || typeof value.at !== "string") {
		return null;
	}
	return { at: value.at, by: typeof value.by === "string" ? value.by : "" };
}

/** Records a resubmit request on the card's entry (creating the entry if the pipeline has none for it yet). */
export async function recordResubmitRequest(
	store: PipelineStateStore,
	input: { workspaceId: string; taskId: string; request: ResubmitRequest },
): Promise<void> {
	await store.update(input.workspaceId, (state) => ({
		...state,
		cards: {
			...state.cards,
			[input.taskId]: { ...state.cards[input.taskId], [RESUBMIT_FIELD]: { ...input.request } },
		},
	}));
}
