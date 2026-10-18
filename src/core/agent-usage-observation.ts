import { z } from "zod";
import { runtimeTaskTokenUsageSchema } from "./api-contract";

export const usageTokenCountsSchema = runtimeTaskTokenUsageSchema
	.pick({ input: true, output: true, cacheRead: true, cacheWrite: true })
	.strict()
	.refine(
		(counts) => Object.values(counts).every((value) => Number.isFinite(value) && value >= 0),
		"Usage counts must be finite and nonnegative.",
	);
export const agentUsageObservationSchema = z
	.object({
		/** Backend-stable identity, scoped to the worktree by the native collector. No transcript content. */
		key: z.string().min(1).max(512),
		agent: z.enum(["claude", "cline", "codex", "copilot"]),
		basis: z.enum(["request", "session_total"]),
		at: z.number().nonnegative().nullable(),
		model: z.string().min(1).max(256).nullable(),
		provider: z.string().min(1).max(80).nullable(),
		tokens: usageTokenCountsSchema.nullable(),
		/** Missing/ambiguous data is explicit; neither absent metrics nor late session totals are zero. */
		uncertainty: z
			.array(
				z.enum([
					"identity_missing",
					"time_missing",
					"usage_missing",
					"cache_breakdown_missing",
					"provider_missing",
					"model_missing",
					"mixed_model",
					"source_corrupt",
					"generation_error",
				]),
			)
			.max(9),
	})
	.strict();
export type AgentUsageObservation = z.infer<typeof agentUsageObservationSchema>;
