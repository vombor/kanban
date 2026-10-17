import { z } from "zod";
import type { PipelineCardState } from "./pipeline-state";

const schema = z.object({
	kind: z.enum(["review", "conclude"]),
	taskId: z.string(),
	qaTaskId: z.string().optional(),
	snapshot: z.string(),
	reason: z.string(),
	at: z.string(),
	by: z.string(),
	status: z.enum(["pending", "running", "held", "complete"]),
});
export function readManualReview(entry: PipelineCardState | undefined) {
	const result = schema.safeParse(entry?.manualReview);
	return result.success ? result.data : null;
}
export function manualReviewHoldReason(entry: PipelineCardState | undefined): string | null {
	const manual = readManualReview(entry);
	return manual && manual.snapshot === entry?.snapshot
		? `explicit ${manual.kind === "conclude" ? "terminal STALLED" : "evidence-only"} review disposition: ${manual.reason}`
		: null;
}
