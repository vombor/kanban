import { z } from "zod";
import { coordinationHintsSchema, coordinationPathSchema } from "../core/coordination-hints";
import type { RuntimeCaller } from "../isolation/session-identity";
import { executionTaskIdSchema } from "./knowledge-execution-contract";

export const coordinationRequestSchema = z.object({ planTaskId: executionTaskIdSchema.optional() }).strict();
export const coordinationTaskSchema = z
	.object({
		id: z.string().max(160),
		taskId: executionTaskIdSchema.nullable(),
		title: z.string().max(200),
		state: z.enum(["planned", "backlog", "in_progress", "review", "trash", "missing"]),
		prerequisites: z
			.object({
				total: z.number().int(),
				done: z.number().int(),
				waiting: z.array(z.string()).max(100),
				missing: z.array(z.string()).max(100),
			})
			.nullable(),
		readiness: z.enum([
			"planned_only",
			"prerequisites_satisfied",
			"waiting_on_prerequisites",
			"missing_prerequisite",
			"not_backlog",
			"blocked_or_unknown",
		]),
		ownerStates: z.array(z.string().max(80)).max(10),
		reviewSettled: z.boolean(),
		model: z.object({ provider: z.string().max(160).nullable(), model: z.string().max(240) }).nullable(),
		capacityHold: z.boolean().nullable(),
		otherProjectHolders: z.number().int().nonnegative(),
		hints: coordinationHintsSchema.nullable(),
		snapshot: z
			.string()
			.regex(/^[a-f0-9]{40,64}$/u)
			.nullable(),
		baseCommit: z
			.string()
			.regex(/^[a-f0-9]{40,64}$/u)
			.nullable(),
		observedPaths: z.array(coordinationPathSchema).max(100),
		pathsTruncated: z.boolean(),
	})
	.strict();
export const coordinationReportSchema = z
	.object({
		generatedAt: z.number(),
		fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
		planTaskId: executionTaskIdSchema.nullable(),
		approvedBundle: z.string().nullable(),
		tasks: z.array(coordinationTaskSchema).max(100),
		dependencies: z
			.array(
				z
					.object({ waiting: z.string(), prerequisite: z.string(), basis: z.enum(["board", "approved_plan"]) })
					.strict(),
			)
			.max(300),
		advice: z
			.array(
				z
					.object({
						kind: z.enum(["path_overlap", "contract_dependency", "provider_serialization"]),
						tasks: z.array(z.string()).min(2).max(2),
						details: z.array(z.string().max(240)).max(10),
						basis: z.enum(["reviewed_hints", "retained_snapshots", "mixed", "configured_capacity"]),
					})
					.strict(),
			)
			.max(200),
		truncated: z.boolean(),
		warnings: z.array(z.string().max(160)).max(20),
		authority: z.literal("advisory_only_not_start_assignment_dependency_qa_or_landing_authority"),
	})
	.strict();
export type CoordinationReport = z.infer<typeof coordinationReportSchema>;
export type CoordinationTask = z.infer<typeof coordinationTaskSchema>;
export interface RuntimeCoordinationApi {
	preview(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof coordinationRequestSchema>,
	): Promise<CoordinationReport>;
}
