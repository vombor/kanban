import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";
export const efficiencyCategorySchema = z.enum([
	"agent_running",
	"checks_running",
	"checks_queued",
	"qa_queued",
	"qa_running",
	"settling",
	"held",
	"recovery",
	"escalated",
	"stopped",
	"review_settled",
	"user_input_wait",
]);
export type EfficiencyCategory = z.infer<typeof efficiencyCategorySchema>;
export const efficiencySpanSchema = z
	.object({
		taskId: z.string().min(1).max(160),
		category: efficiencyCategorySchema,
		start: z.number().nonnegative(),
		end: z.number().nonnegative(),
	})
	.strict();
export type EfficiencySpan = z.infer<typeof efficiencySpanSchema>;
export const efficiencyRequestSchema = z
	.object({
		taskId: z.string().min(1).max(160).optional(),
		planTaskId: z.string().min(1).max(160).optional(),
		objectiveId: z
			.string()
			.regex(/^obj-[a-f0-9-]{36}$/u)
			.optional(),
	})
	.strict()
	.refine(
		(input) => [input.taskId, input.planTaskId, input.objectiveId].filter(Boolean).length <= 1,
		"Choose task, plan or objective, not multiple scopes",
	);
const component = z
	.object({
		kind: z.string().max(40),
		tasks: z.number().int().nonnegative(),
		observedEstimatedUsd: z.number().nonnegative().nullable(),
		observedTokens: z
			.object({
				input: z.number().nonnegative(),
				output: z.number().nonnegative(),
				cacheRead: z.number().nonnegative(),
				cacheWrite: z.number().nonnegative(),
			})
			.nullable(),
	})
	.strict();
export const efficiencyReportSchema = z
	.object({
		generatedAt: z.number().nonnegative(),
		scope: z.enum(["project", "task", "objective", "plan"]),
		taskCount: z.number().int().nonnegative(),
		observedAgentRunningMs: z.number().nonnegative().nullable(),
		observedElapsedMs: z.number().nonnegative().nullable(),
		summedSampledMs: z.number().nonnegative().nullable(),
		timing: z.array(z.object({ category: efficiencyCategorySchema, sampledMs: z.number().nonnegative() }).strict()),
		components: z.array(component).max(10),
		observedEstimatedUsd: z.number().nonnegative().nullable(),
		totalEstimatedUsd: z.null(),
		priceRevisions: z.array(z.string()).max(50),
		coverage: z.literal("partial_or_unknown"),
		forecast: z.literal("insufficient_evidence"),
		warnings: z.array(z.string().max(160)).max(30),
		priceSources: z.array(z.enum(["seed", "configured"])).max(2),
		chargeKinds: z.array(z.enum(["unmetered", "table_estimate"])).max(2),
		authority: z.literal("report_only_not_acceptance_or_billing"),
	})
	.strict();
export type EfficiencyReport = z.infer<typeof efficiencyReportSchema>;
export interface RuntimeEfficiencyApi {
	report(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof efficiencyRequestSchema>,
	): Promise<EfficiencyReport>;
}
