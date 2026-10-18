import { z } from "zod";
import { agentUsageObservationSchema } from "./agent-usage-observation";

export const objectiveUsageRecordSchema = z
	.object({
		id: z.string().regex(/^[a-f0-9]{64}$/u),
		version: z.string().regex(/^[a-f0-9]{64}$/u),
		taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u),
		requirementsHash: z.string().regex(/^[a-f0-9]{64}$/u),
		observedAt: z.string().datetime({ offset: true }),
		attemptId: z
			.string()
			.regex(/^[a-f0-9]{64}$/u)
			.nullable(),
		observation: agentUsageObservationSchema,
		price: z
			.object({
				revision: z.string().regex(/^[a-f0-9]{64}$/u),
				source: z.enum(["seed", "configured"]),
				kind: z.enum(["table_estimate", "unmetered"]),
				rates: z
					.object({
						input: z.number().nonnegative(),
						output: z.number().nonnegative(),
						cacheRead: z.number().nonnegative(),
						cacheWrite: z.number().nonnegative(),
					})
					.strict(),
				estimatedUsd: z.number().nonnegative(),
			})
			.strict()
			.nullable(),
		uncertainty: z.array(z.string().min(1).max(80)).max(20),
	})
	.strict();
export type ObjectiveUsageRecord = z.infer<typeof objectiveUsageRecordSchema>;
