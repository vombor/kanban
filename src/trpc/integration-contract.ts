import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";
import { executionTaskIdSchema } from "./knowledge-execution-contract";

const hash = z.string().regex(/^[a-f0-9]{64}$/u),
	commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const integrationSelectionSchema = z
	.object({
		taskIds: z
			.array(executionTaskIdSchema)
			.min(2)
			.max(6)
			.refine((ids) => new Set(ids).size === ids.length),
		planTaskId: executionTaskIdSchema.optional(),
	})
	.strict();
export const integrationManifestSchema = z
	.object({
		version: z.literal(1),
		fingerprint: hash,
		sourceFingerprint: hash,
		baseCommit: commit,
		selection: integrationSelectionSchema,
		members: z
			.array(
				z.object({ taskId: executionTaskIdSchema, snapshot: commit, contextRevision: hash.nullable() }).strict(),
			)
			.min(2)
			.max(6),
		checksFingerprint: hash,
		toolchainFingerprint: hash,
		scripts: z.array(z.string().max(80)).max(20),
		warnings: z.array(z.string().max(160)).max(20),
		authority: z.literal("speculative_report_not_qa_or_landing_approval"),
	})
	.strict();
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
export const integrationRunSchema = integrationSelectionSchema
	.extend({ requestId: z.string().uuid(), fingerprint: hash })
	.strict();
export const integrationReportSchema = z
	.object({
		id: z.string().uuid(),
		manifest: integrationManifestSchema,
		status: z.enum([
			"reserved",
			"running",
			"conflicts",
			"checks_passed",
			"checks_failed",
			"unavailable",
			"uncertain",
		]),
		createdAt: z.number(),
		finishedAt: z.number().nullable(),
		candidateCommit: commit.nullable(),
		candidateTree: commit.nullable(),
		conflictTaskId: executionTaskIdSchema.nullable(),
		steps: z
			.array(
				z
					.object({
						name: z.string().max(160),
						status: z.enum(["ok", "fail", "timeout", "skipped"]),
						harness: z.boolean(),
						advisory: z.boolean().default(false),
					})
					.strict(),
			)
			.max(100),
		reason: z.string().max(160).nullable(),
		cleanup: z.enum(["not_created", "complete", "retained_uncertain"]),
		freshness: z.enum(["current", "stale", "unknown"]),
		authority: z.literal("speculative_report_not_qa_or_landing_approval"),
	})
	.strict();
export type IntegrationReport = z.infer<typeof integrationReportSchema>;
export const integrationReadSchema = z.object({ id: z.string().uuid() }).strict();
export const integrationListSchema = z.object({ offset: z.number().int().min(0).max(100).default(0) }).strict();
export const integrationListResponseSchema = z
	.object({
		reports: z.array(integrationReportSchema.pick({ id: true, status: true, createdAt: true })).max(20),
		nextOffset: z.number().int().nullable(),
	})
	.strict();
export interface RuntimeIntegrationApi {
	list(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof integrationListSchema>,
	): Promise<z.infer<typeof integrationListResponseSchema>>;
	preview(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof integrationSelectionSchema>,
	): Promise<IntegrationManifest>;
	run(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof integrationRunSchema>,
	): Promise<IntegrationReport>;
	read(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof integrationReadSchema>,
	): Promise<IntegrationReport>;
}
