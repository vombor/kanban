import { z } from "zod";
import { providerConcurrencySchema } from "../core/provider-concurrency";
import type { RuntimeCaller } from "../isolation/session-identity";

export const pipelineControlSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("pacing"), provider: z.string(), limit: z.number().int().min(1).max(1024).nullable() })
		.strict()
		.refine(
			(value) => providerConcurrencySchema.safeParse({ [value.provider]: value.limit ?? 1 }).success,
			"Invalid provider identifier/limit",
		),
	z
		.object({
			kind: z.literal("acknowledge"),
			taskId: z.string().min(1),
			disposition: z.enum(["held", "deferred", "clear"]),
			reason: z.string().min(1).max(2000),
			until: z.iso.datetime().optional(),
			waitForTaskId: z.string().min(1).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("conclude"),
			taskId: z.string().min(1),
			qaTaskId: z.string().min(1),
			snapshot: z.string().min(1),
			reason: z.string().min(1).max(2000),
		})
		.strict(),
	z
		.object({
			kind: z.literal("review"),
			taskId: z.string().min(1),
			snapshot: z.string().min(1),
			reason: z.string().min(1).max(2000),
			evidenceOnly: z.literal(true),
		})
		.strict(),
]);
export const pipelineControlResponseSchema = z.object({
	ok: z.boolean(),
	message: z.string().optional(),
	error: z.string().optional(),
});
export type PipelineControl = z.infer<typeof pipelineControlSchema>;
export interface RuntimePipelineControlApi {
	request: (
		caller: RuntimeCaller,
		workspaceId: string,
		request: PipelineControl,
	) => Promise<z.infer<typeof pipelineControlResponseSchema>>;
}
