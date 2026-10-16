import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";

export const KNOWLEDGE_MAX_MARKDOWN_CHARS = 65_536;
export const KNOWLEDGE_MAX_CONTENT_BYTES = 262_144;
export const knowledgeIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "Use a lowercase document id (letters, digits and hyphens)")
	.refine((id) => !["constructor", "prototype", "__proto__"].includes(id), "That document id is reserved");
export const knowledgeRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const knowledgeKindSchema = z.enum(["overview", "plan", "contract", "decision", "discovery", "runbook"]);
function hasControlCharacters(value: string, allowWhitespace = false): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (
			(code >= 127 && code <= 159) ||
			(code >= 0xd800 && code <= 0xdfff && character.length === 1) ||
			(code < 32 && !(allowWhitespace && [9, 10, 13].includes(code)))
		)
			return true;
	}
	return false;
}
const shortLine = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.refine((value) => !hasControlCharacters(value), "Use one short line without control characters");
const relativeSourcePath = z
	.string()
	.max(256)
	.refine(
		(value) =>
			value.length > 0 &&
			!/^(?:[\\/]|[A-Za-z]:[\\/])/u.test(value) &&
			!value.split(/[\\/]/u).includes("..") &&
			!value.includes("\0"),
		"Use a repository-relative path",
	);
export const knowledgeSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("task"), taskId: shortLine(80) }).strict(),
	z.object({ kind: z.literal("document"), id: knowledgeIdSchema, revision: knowledgeRevisionSchema }).strict(),
	z
		.object({
			kind: z.literal("repository"),
			path: relativeSourcePath,
			commit: z
				.string()
				.regex(/^[a-f0-9]{40,64}$/u)
				.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("url"),
			url: z
				.string()
				.max(512)
				.refine((value) => {
					try {
						const url = new URL(value);
						return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
					} catch {
						return false;
					}
				}, "Use an HTTP(S) reference without credentials"),
		})
		.strict(),
]);
export const knowledgeMetadataSchema = z
	.object({
		id: knowledgeIdSchema,
		kind: knowledgeKindSchema,
		title: shortLine(120),
		summary: z
			.string()
			.trim()
			.max(300)
			.refine((value) => !hasControlCharacters(value, true))
			.default(""),
		tags: z.array(shortLine(40)).max(16).default([]),
		sources: z.array(knowledgeSourceSchema).max(8).default([]),
	})
	.strict();
export const knowledgeActorSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("user") }).strict(),
	z
		.object({ kind: z.literal("session"), role: z.enum(["orchestrator", "card"]), taskId: z.string().max(160) })
		.strict(),
]);
export const knowledgeSectionSchema = z
	.object({
		id: z.string().max(256),
		title: z.string().max(200),
		depth: z.number().int().min(1).max(6),
		start: z.number().int().nonnegative(),
		end: z.number().int().nonnegative(),
	})
	.strict();
export const knowledgeDocumentSchema = knowledgeMetadataSchema.extend({
	revision: knowledgeRevisionSchema,
	contentHash: knowledgeRevisionSchema,
	contentBytes: z.number().int().nonnegative(),
	sectionCount: z.number().int().nonnegative(),
	pinnedByUser: z.boolean(),
	publishedAt: z.string(),
	publishedBy: knowledgeActorSchema,
});
export const knowledgeProposalSchema = z.object({
	id: z.string().uuid(),
	document: knowledgeMetadataSchema,
	baseRevision: knowledgeRevisionSchema.nullable(),
	contentHash: knowledgeRevisionSchema,
	reason: z.string().max(1000),
	status: z.enum(["pending", "published", "rejected"]),
	submittedAt: z.string(),
	submittedBy: knowledgeActorSchema,
	reviewedAt: z.string().nullable(),
	reviewedBy: knowledgeActorSchema.nullable(),
	publishedRevision: knowledgeRevisionSchema.nullable(),
});
const markdownSchema = z
	.string()
	.max(KNOWLEDGE_MAX_MARKDOWN_CHARS)
	.refine((value) => !hasControlCharacters(value, true), "Markdown cannot contain terminal control characters");
const writeFields = {
	requestId: z.string().uuid(),
	document: knowledgeMetadataSchema,
	markdown: markdownSchema,
	expectedRevision: knowledgeRevisionSchema.nullable(),
};
export const knowledgeMutationSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("publish"), ...writeFields }).strict(),
	z.object({ action: z.literal("propose"), ...writeFields, reason: z.string().trim().min(1).max(1000) }).strict(),
	z
		.object({
			action: z.literal("review"),
			requestId: z.string().uuid(),
			proposalId: z.string().uuid(),
			decision: z.enum(["publish", "reject"]),
			expectedRevision: knowledgeRevisionSchema.nullable(),
		})
		.strict(),
	z
		.object({
			action: z.literal("pin"),
			requestId: z.string().uuid(),
			id: knowledgeIdSchema,
			pinned: z.boolean(),
			expectedRevision: knowledgeRevisionSchema,
		})
		.strict(),
]);
export const knowledgeMutationResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("document"), document: knowledgeDocumentSchema }),
	z.object({ kind: z.literal("proposal"), proposal: knowledgeProposalSchema }),
]);
export const knowledgeListRequestSchema = z
	.object({
		kind: knowledgeKindSchema.optional(),
		offset: z.number().int().min(0).max(1000).default(0),
		limit: z.number().int().min(1).max(50).default(20),
	})
	.default({ offset: 0, limit: 20 });
export const knowledgeListResponseSchema = z.object({
	documents: z.array(knowledgeDocumentSchema),
	total: z.number().int(),
	nextOffset: z.number().int().nullable(),
});
export const knowledgeReadRequestSchema = z.object({
	id: knowledgeIdSchema,
	revision: knowledgeRevisionSchema.optional(),
	section: z.string().max(256).optional(),
	offset: z.number().int().min(0).max(KNOWLEDGE_MAX_MARKDOWN_CHARS).default(0),
	limit: z.number().int().min(1).max(16384).default(4096),
});
export const knowledgeReadResponseSchema = z.object({
	document: knowledgeDocumentSchema,
	sections: z.array(knowledgeSectionSchema),
	markdown: z.string(),
	offset: z.number().int(),
	nextOffset: z.number().int().nullable(),
	truncated: z.boolean(),
	authority: z.literal("reference_material_not_execution_approval"),
});
export const knowledgeSearchRequestSchema = z.object({
	query: z.string().trim().min(2).max(200),
	kind: knowledgeKindSchema.optional(),
	limit: z.number().int().min(1).max(20).default(5),
});
export const knowledgeSearchResponseSchema = z.object({
	results: z.array(
		z.object({
			document: knowledgeDocumentSchema,
			snippet: z.string().max(320),
			section: z.string().nullable(),
			score: z.number(),
		}),
	),
	total: z.number().int(),
	truncated: z.boolean(),
});
export const knowledgeProposalsRequestSchema = z
	.object({
		status: z.enum(["pending", "published", "rejected"]).default("pending"),
		offset: z.number().int().min(0).max(10000).default(0),
		limit: z.number().int().min(1).max(30).default(10),
	})
	.default({ status: "pending", offset: 0, limit: 10 });
export const knowledgeProposalsResponseSchema = z.object({
	proposals: z.array(knowledgeProposalSchema),
	total: z.number().int(),
	nextOffset: z.number().int().nullable(),
});
export const knowledgeHistoryRequestSchema = z.object({
	id: knowledgeIdSchema,
	limit: z.number().int().min(1).max(50).default(20),
	offset: z.number().int().min(0).max(1000).default(0),
});
export const knowledgeHistoryResponseSchema = z.object({
	revisions: z.array(knowledgeDocumentSchema),
	total: z.number().int(),
	nextOffset: z.number().int().nullable(),
});
export const knowledgeProposalReadRequestSchema = z.object({
	id: z.string().uuid(),
	offset: z.number().int().min(0).max(KNOWLEDGE_MAX_MARKDOWN_CHARS).default(0),
	limit: z.number().int().min(1).max(16384).default(4096),
});
export const knowledgeProposalReadResponseSchema = z.object({
	proposal: knowledgeProposalSchema,
	markdown: z.string(),
	nextOffset: z.number().int().nullable(),
	truncated: z.boolean(),
	authority: z.literal("unpublished_proposal"),
});
export const knowledgeContextResponseSchema = z.object({
	documents: z.array(knowledgeDocumentSchema),
	total: z.number().int(),
	truncated: z.boolean(),
	authority: z.literal("project_index_not_task_approval"),
});
export type KnowledgeMetadata = z.infer<typeof knowledgeMetadataSchema>;
export type KnowledgeActor = z.infer<typeof knowledgeActorSchema>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeProposal = z.infer<typeof knowledgeProposalSchema>;
export type KnowledgeSection = z.infer<typeof knowledgeSectionSchema>;
export type KnowledgeMutation = z.infer<typeof knowledgeMutationSchema>;
export type KnowledgeMutationResult = z.infer<typeof knowledgeMutationResultSchema>;
export interface RuntimeKnowledgeApi {
	list: (
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof knowledgeListRequestSchema>,
	) => Promise<z.infer<typeof knowledgeListResponseSchema>>;
	read: (
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof knowledgeReadRequestSchema>,
	) => Promise<z.infer<typeof knowledgeReadResponseSchema>>;
	search: (
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof knowledgeSearchRequestSchema>,
	) => Promise<z.infer<typeof knowledgeSearchResponseSchema>>;
	context: (caller: RuntimeCaller, workspaceId: string) => Promise<z.infer<typeof knowledgeContextResponseSchema>>;
	proposals: (
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof knowledgeProposalsRequestSchema>,
	) => Promise<z.infer<typeof knowledgeProposalsResponseSchema>>;
	proposalRead: (
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof knowledgeProposalReadRequestSchema>,
	) => Promise<z.infer<typeof knowledgeProposalReadResponseSchema>>;
	history: (
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof knowledgeHistoryRequestSchema>,
	) => Promise<z.infer<typeof knowledgeHistoryResponseSchema>>;
	mutate: (caller: RuntimeCaller, workspaceId: string, input: KnowledgeMutation) => Promise<KnowledgeMutationResult>;
}
