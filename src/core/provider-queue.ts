import { z } from "zod";
export const runtimeProviderQueueSchema = z.object({
	providerId: z.string().nullable(),
	requestedAt: z.number(),
	until: z.number().nullable(),
});
