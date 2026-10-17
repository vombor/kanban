import { z } from "zod";
export const providerDispatchStatusSchema = z.object({
	limits: z.record(z.string(), z.number()),
	queued: z.array(
		z.object({
			taskId: z.string(),
			providerId: z.string().nullable(),
			requestedAt: z.number(),
			until: z.number().nullable(),
		}),
	),
	holders: z.array(z.object({ taskId: z.string(), resources: z.array(z.string()) })),
	otherActive: z.number().int().nonnegative(),
});
export type ProviderDispatchStatus = z.infer<typeof providerDispatchStatusSchema>;
