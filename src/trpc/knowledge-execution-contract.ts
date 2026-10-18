import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";
import {
	knowledgeDocumentSchema,
	knowledgeIdSchema,
	knowledgeRevisionSchema,
	knowledgeSectionSchema,
} from "./knowledge-contract";

export const executionTaskIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u)
	.refine((id) => id !== "prototype" && !Object.hasOwn(Object.prototype, id), "That task id is reserved");
export const planBundlePartSchema = z
	.object({
		contentHash: knowledgeRevisionSchema,
		contentBytes: z.number().int().nonnegative().max(262144),
		path: z.string().min(1).max(256),
	})
	.strict();
export const planBundleDefinitionSchema = z
	.object({
		version: z.literal(1),
		planTaskId: executionTaskIdSchema,
		slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
		spec: planBundlePartSchema,
		breakdown: planBundlePartSchema,
		documents: z.array(knowledgeDocumentSchema).max(40),
	})
	.strict()
	.superRefine((bundle, context) => {
		if (new Set(bundle.documents.map((document) => document.id)).size !== bundle.documents.length)
			context.addIssue({
				code: "custom",
				message: "Each pinned knowledge id must have one explicit revision in the reviewed bundle.",
			});
	});
export const planBundleSchema = planBundleDefinitionSchema.safeExtend({ revision: knowledgeRevisionSchema });
export type PlanBundleDefinition = z.infer<typeof planBundleDefinitionSchema>;
export type PlanBundle = z.infer<typeof planBundleSchema>;

export const taskContextAdoptionSchema = z
	.object({
		requestId: z.string().uuid(),
		parentRevision: knowledgeRevisionSchema,
		documentId: knowledgeIdSchema,
		previousRevision: knowledgeRevisionSchema,
		targetRevision: knowledgeRevisionSchema,
		reason: z.string().trim().min(1).max(1000),
		by: z.literal("user"),
		at: z.string().datetime({ offset: true }),
	})
	.strict();
export const taskContextStartReservationSchema = z
	.object({ contextRevision: knowledgeRevisionSchema, at: z.string().datetime({ offset: true }) })
	.strict();
export type TaskContextStartReservation = z.infer<typeof taskContextStartReservationSchema>;
export const taskContextInheritanceSchema = z
	.object({
		sourceTaskId: executionTaskIdSchema,
		sourceContextRevision: knowledgeRevisionSchema,
		kind: z.enum(["qa", "escalation", "runoff"]),
		snapshot: z
			.string()
			.regex(/^[a-f0-9]{40,64}$/u)
			.optional(),
	})
	.strict();
export const knowledgeSourceSchema = taskContextInheritanceSchema.omit({ sourceContextRevision: true }).extend({
	// Legacy board ids may not be valid new execution ids. They cannot hold native pins, but remain reference sources.
	sourceTaskId: z
		.string()
		.min(1)
		.max(160)
		.refine((id) => id !== "prototype" && !Object.hasOwn(Object.prototype, id), "Reserved source id"),
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export const knowledgeAttemptSchema = z
	.object({
		id: knowledgeRevisionSchema,
		taskId: executionTaskIdSchema,
		contextRevision: knowledgeRevisionSchema,
		kind: z.enum(["session", "rework_handoff"]),
		reservedAt: z.string().datetime({ offset: true }),
		outcome: z.enum(["reserved", "started", "uncertain"]),
		startedAt: z.number().nonnegative().nullable(),
		snapshot: z
			.string()
			.regex(/^[a-f0-9]{40,64}$/u)
			.optional(),
		round: z.number().int().nonnegative().optional(),
	})
	.strict();
export type KnowledgeAttempt = z.infer<typeof knowledgeAttemptSchema>;
export const taskKnowledgeContextSchema = z
	.object({
		version: z.literal(1),
		taskId: executionTaskIdSchema,
		planTaskId: executionTaskIdSchema,
		bundleRevision: knowledgeRevisionSchema,
		revision: knowledgeRevisionSchema,
		documents: z.array(knowledgeDocumentSchema).max(40),
		attachedAt: z.string().datetime({ offset: true }),
		adoption: taskContextAdoptionSchema.optional(),
		inheritance: taskContextInheritanceSchema.optional(),
	})
	.strict();
export type TaskKnowledgeContext = z.infer<typeof taskKnowledgeContextSchema>;
export const taskKnowledgeRequestSchema = z.object({ taskId: executionTaskIdSchema }).strict();
export const taskExpansionContextRequestSchema = z.object({ planTaskId: executionTaskIdSchema }).strict();
export const taskDerivedContextRequestSchema = knowledgeSourceSchema.extend({ taskId: executionTaskIdSchema }).strict();
export const taskKnowledgeAttemptsRequestSchema = taskKnowledgeRequestSchema.extend({
	offset: z.number().int().min(0).max(1000).default(0),
	limit: z.number().int().min(1).max(30).default(10),
});
export const taskKnowledgeAttemptsResponseSchema = z
	.object({
		authority: z.literal("reference_provenance_not_execution_approval"),
		attempts: z.array(knowledgeAttemptSchema).max(30),
		total: z.number().int().nonnegative(),
		nextOffset: z.number().int().nullable(),
	})
	.strict();
export const taskContextAdoptRequestSchema = z
	.object({
		taskId: executionTaskIdSchema,
		requestId: z.string().uuid(),
		expectedContextRevision: knowledgeRevisionSchema,
		documentId: knowledgeIdSchema,
		expectedDocumentRevision: knowledgeRevisionSchema,
		targetRevision: knowledgeRevisionSchema,
		reason: z.string().trim().min(1).max(1000),
	})
	.strict();
export type TaskContextAdoptRequest = z.infer<typeof taskContextAdoptRequestSchema>;
export const taskContextAdoptResponseSchema = z
	.object({
		context: taskKnowledgeContextSchema,
		duplicate: z.boolean(),
		authority: z.literal("pinned_reference_not_execution_approval"),
	})
	.strict();
export const taskKnowledgeReadRequestSchema = taskKnowledgeRequestSchema
	.extend({
		contextRevision: knowledgeRevisionSchema.optional(),
		attemptId: knowledgeRevisionSchema.optional(),
		part: z.enum(["spec", "breakdown", "document"]),
		id: knowledgeIdSchema.optional(),
		section: z.string().max(256).optional(),
		offset: z.number().int().min(0).max(262144).default(0),
		limit: z.number().int().min(1).max(16384).default(4096),
	})
	.strict()
	.superRefine((input, context) => {
		if ((input.part === "document") !== Boolean(input.id))
			context.addIssue({
				code: "custom",
				message: "Document reads name one pinned id; plan parts do not accept another document selector.",
			});
		if (input.part === "breakdown" && input.section)
			context.addIssue({ code: "custom", message: "The JSON breakdown has no Markdown sections." });
	});
export const taskKnowledgeResponseSchema = z
	.object({
		context: taskKnowledgeContextSchema.nullable(),
		bundle: planBundleSchema.nullable(),
		history: z
			.array(
				z
					.object({
						revision: knowledgeRevisionSchema,
						attachedAt: z.string().datetime({ offset: true }),
						adoption: taskContextAdoptionSchema.nullable(),
					})
					.strict(),
			)
			.max(100)
			.default([]),
		startReservation: taskContextStartReservationSchema.nullable().default(null),
		canAdopt: z.boolean().default(false),
		drift: z
			.array(
				z
					.object({
						id: knowledgeIdSchema,
						pinned: knowledgeRevisionSchema,
						current: knowledgeRevisionSchema.nullable(),
					})
					.strict(),
			)
			.max(40),
		authority: z.literal("pinned_reference_not_execution_approval"),
	})
	.strict();

export interface RuntimeTaskKnowledgeApi {
	attachDerived(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof taskDerivedContextRequestSchema>,
	): Promise<{ context: TaskKnowledgeContext | null }>;
	attempts(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof taskKnowledgeAttemptsRequestSchema>,
	): Promise<z.infer<typeof taskKnowledgeAttemptsResponseSchema>>;
	adopt(
		caller: RuntimeCaller,
		workspaceId: string,
		input: TaskContextAdoptRequest,
	): Promise<z.infer<typeof taskContextAdoptResponseSchema>>;
	get(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof taskKnowledgeRequestSchema>,
	): Promise<z.infer<typeof taskKnowledgeResponseSchema>>;
	read(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof taskKnowledgeReadRequestSchema>,
	): Promise<z.infer<typeof taskKnowledgeReadResponseSchema>>;
	attachExpansion(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof taskExpansionContextRequestSchema>,
	): Promise<{ ok: true }>;
}
export const taskKnowledgeReadResponseSchema = z
	.object({
		contextRevision: knowledgeRevisionSchema,
		contentHash: knowledgeRevisionSchema,
		sections: z.array(knowledgeSectionSchema).max(128),
		markdown: z.string().max(16384),
		offset: z.number().int().nonnegative(),
		nextOffset: z.number().int().nullable(),
		truncated: z.boolean(),
		authority: z.literal("pinned_reference_not_execution_approval"),
	})
	.strict();
