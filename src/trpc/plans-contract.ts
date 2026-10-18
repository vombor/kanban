import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";
import { planBundleSchema } from "./knowledge-execution-contract";

export const planApprovalSchema = z
	.object({
		at: z.string(),
		via: z.enum(["approve", "expand"]),
		breakdownSha256: z.string(),
		/** Absent only for historical breakdown-only approvals; never retroactively adopted as full-bundle approval. */
		bundleRevision: z
			.string()
			.regex(/^[a-f0-9]{64}$/u)
			.optional(),
	})
	.strict();
export type PlanApproval = z.infer<typeof planApprovalSchema>;
export const planApprovalPreviewSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	slug: z.string(),
	specPath: z.string(),
	specTitle: z.string().nullable(),
	cards: z.number().int().nonnegative(),
	breakdownSha256: z.string(),
	bundle: planBundleSchema,
	approval: planApprovalSchema
		.extend({ state: z.enum(["approved", "stale", "not approved", "legacy breakdown only"]) })
		.nullable(),
});
export type PlanApprovalPreview = z.infer<typeof planApprovalPreviewSchema>;
export const planPreviewRequestSchema = z.object({ taskId: z.string().min(1) });
export const planPreviewResponseSchema = z.object({
	ok: z.boolean(),
	plan: planApprovalPreviewSchema.nullable(),
	error: z.string().optional(),
});
export type PlanPreviewResponse = z.infer<typeof planPreviewResponseSchema>;
export const planApproveRequestSchema = z.object({
	taskId: z.string().min(1),
	via: z.enum(["approve", "expand"]).default("approve"),
	breakdownSha256: z.string().min(1).nullable().default(null),
	bundleRevision: z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.nullable()
		.default(null),
});
export const planApproveResponseSchema = z.object({
	ok: z.boolean(),
	approval: planApprovalSchema.nullable(),
	plan: planApprovalPreviewSchema.nullable(),
	error: z.string().optional(),
});
export type PlanApproveResponse = z.infer<typeof planApproveResponseSchema>;
export interface RuntimePlansApi {
	preview: (
		repoPath: string,
		input: z.infer<typeof planPreviewRequestSchema>,
		caller: RuntimeCaller,
		workspaceId: string,
	) => Promise<PlanPreviewResponse>;
	approve: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		repoPath: string;
		request: z.infer<typeof planApproveRequestSchema>;
	}) => Promise<PlanApproveResponse>;
}
