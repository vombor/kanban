import { createHash } from "node:crypto";
import { z } from "zod";
import { type RuntimeBoardCard, runtimeTaskSessionStartRequestSchema } from "./api-contract";

export const providerStartIntentSchema = z
	.object({
		id: z.string().optional(),
		taskId: z.string(),
		body: runtimeTaskSessionStartRequestSchema,
		fingerprint: z.string(),
		at: z.number(),
		explicit: z.boolean(),
	})
	.strict();
export const providerStartQueueSchema = z
	.object({ version: z.literal(1), pending: z.array(providerStartIntentSchema).max(1000) })
	.strict();

/** Excludes the broker's own queued badge/timestamp, but includes every material launch requirement. */
export function providerStartFingerprint(card: RuntimeBoardCard): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				title: card.title,
				prompt: card.prompt,
				baseRef: card.baseRef,
				agentId: card.agentId,
				settings: card.agentSettings,
				plan: card.startInPlanMode,
				images: card.images,
				git: card.autoReviewMode,
			}),
		)
		.digest("hex");
}
