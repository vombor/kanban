import { z } from "zod";
import {
	knowledgeActorSchema,
	knowledgeIdSchema,
	knowledgeMetadataSchema,
	knowledgeMutationResultSchema,
	knowledgeProposalSchema,
	knowledgeRevisionSchema,
	knowledgeSectionSchema,
} from "../trpc/knowledge-contract";

export const knowledgeStoredRevisionSchema = z
	.object({
		revision: knowledgeRevisionSchema,
		parentRevision: knowledgeRevisionSchema.nullable(),
		document: knowledgeMetadataSchema,
		contentHash: knowledgeRevisionSchema,
		contentBytes: z.number().int().min(0).max(262144),
		sections: z.array(knowledgeSectionSchema).max(128),
		pinnedByUser: z.boolean(),
		publishedAt: z.string(),
		publishedBy: knowledgeActorSchema,
		action: z.enum(["publish", "pin"]),
	})
	.strict();
export const knowledgeManifestSchema = z
	.object({
		version: z.literal(1),
		documents: z.record(knowledgeIdSchema, z.array(knowledgeStoredRevisionSchema).min(1).max(1000)),
		proposals: z.record(z.string().uuid(), knowledgeProposalSchema),
		receipts: z.record(
			z.string().uuid(),
			z.object({ requestHash: knowledgeRevisionSchema, result: knowledgeMutationResultSchema }).strict(),
		),
	})
	.strict();
export type KnowledgeStoredRevision = z.infer<typeof knowledgeStoredRevisionSchema>;
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;
export function emptyKnowledgeManifest(): KnowledgeManifest {
	return { version: 1, documents: {}, proposals: {}, receipts: {} };
}
