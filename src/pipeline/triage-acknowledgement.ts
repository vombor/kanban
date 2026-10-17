import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeBoardData } from "../core/api-contract";
import type { PipelineCardState } from "./pipeline-state";

const ackSchema = z.object({
	disposition: z.enum(["held", "deferred"]),
	reason: z.string(),
	fingerprint: z.string(),
	until: z.string().nullable(),
	waitForTaskId: z.string().nullable(),
	prerequisite: z.string().nullable(),
	at: z.string(),
	by: z.string(),
});

/** Changed escalation/snapshot/verdict/column/card evidence invalidates the acknowledgement; it is never a verdict. */
export function triageFingerprint(
	board: RuntimeBoardData,
	cards: Record<string, PipelineCardState>,
	taskId: string,
): string {
	const column = board.columns.find((column) => column.cards.some((card) => card.id === taskId));
	const card = column?.cards.find((card) => card.id === taskId);
	const entry = cards[taskId];
	return createHash("sha256")
		.update(
			JSON.stringify({
				column: column?.id ?? null,
				updatedAt: card?.updatedAt ?? null,
				snapshot: entry?.snapshot ?? null,
				flow: entry?.qaflow ?? null,
				verdicts: entry?.qaVerdicts ?? null,
			}),
		)
		.digest("hex");
}

export function readCurrentTriageAck(
	board: RuntimeBoardData,
	cards: Record<string, PipelineCardState>,
	taskId: string,
	now: number,
) {
	const parsed = ackSchema.safeParse(cards[taskId]?.triageAck);
	if (!parsed.success) return null;
	const ack = parsed.data;
	if (ack.until && (!Number.isFinite(Date.parse(ack.until)) || now >= Date.parse(ack.until))) return null;
	if (ack.fingerprint !== triageFingerprint(board, cards, taskId)) return null;
	if (ack.waitForTaskId && ack.prerequisite !== triageFingerprint(board, cards, ack.waitForTaskId)) return null;
	return ack;
}
