import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";
import {
	hasControlCharacters,
	knowledgeIdSchema,
	knowledgeRevisionSchema,
	knowledgeSectionSchema,
} from "./knowledge-contract";

export const discoveryPathSchema = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(value) =>
			!hasControlCharacters(value) &&
			!value.startsWith("/") &&
			!/[\\%:]/u.test(value) &&
			value
				.split("/")
				.every(
					(part) =>
						part &&
						part !== "." &&
						part !== ".." &&
						!part.startsWith(".") &&
						!part.endsWith(".") &&
						!part.endsWith(" "),
				),
		"Use a bounded non-hidden portable relative Markdown path",
	);
export const discoveryCollectionSchema = z
	.object({
		id: knowledgeIdSchema,
		title: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.refine((value) => !hasControlCharacters(value)),
		obsidianFolder: discoveryPathSchema.nullable().default(null),
	})
	.strict();
export type DiscoveryCollection = z.infer<typeof discoveryCollectionSchema>;
export const discoveryPolicyViewSchema = z
	.object({
		globalRevision: z.string().nullable(),
		projectRevision: z.string().nullable(),
		collections: z.array(discoveryCollectionSchema).max(30),
		shared: z.array(knowledgeIdSchema).max(30),
		obsidianFolder: discoveryPathSchema.nullable(),
	})
	.strict();
export const discoveryPolicySaveSchema = z
	.object({
		globalRevision: z.string().nullable(),
		projectRevision: z.string().nullable(),
		shared: z.array(knowledgeIdSchema).max(30),
		obsidianFolder: discoveryPathSchema.nullable(),
	})
	.strict();
export const discoveryCollectionSaveSchema = z
	.object({ globalRevision: z.string().nullable(), collection: discoveryCollectionSchema })
	.strict();
export const discoveryPointerSchema = z
	.object({ collection: z.string().min(1).max(96), path: discoveryPathSchema, revision: knowledgeRevisionSchema })
	.strict();
export type DiscoveryPointer = z.infer<typeof discoveryPointerSchema>;
export const discoveryNoteSchema = discoveryPointerSchema
	.extend({ title: z.string().max(200), tags: z.array(z.string().max(80)).max(40), snippet: z.string().max(300) })
	.strict();
export type DiscoveryNote = z.infer<typeof discoveryNoteSchema>;
export const discoveryQuerySchema = z
	.object({
		query: z.string().trim().max(200).default(""),
		offset: z.number().int().min(0).max(1000).default(0),
		limit: z.number().int().min(1).max(30).default(10),
	})
	.strict();
export const discoveryQueryResponseSchema = z
	.object({
		notes: z.array(discoveryNoteSchema).max(30),
		total: z.number().int().nonnegative(),
		nextOffset: z.number().int().nullable(),
		truncated: z.boolean(),
		warnings: z.array(z.string().max(80)).max(20),
		authority: z.literal("mutable_discovery_not_execution_approval"),
	})
	.strict();
export const discoveryReadSchema = discoveryPointerSchema
	.extend({
		offset: z.number().int().min(0).max(262144).default(0),
		limit: z.number().int().min(1).max(16384).default(4096),
		section: z.string().max(256).optional(),
	})
	.strict();
export const discoveryReadResponseSchema = z
	.object({
		note: discoveryNoteSchema,
		markdown: z.string().max(16384),
		sections: z.array(knowledgeSectionSchema).max(128),
		nextOffset: z.number().int().nullable(),
		authority: z.literal("mutable_discovery_not_execution_approval"),
	})
	.strict();
export const discoveryGraphRequestSchema = discoveryPointerSchema
	.extend({ depth: z.number().int().min(0).max(3).default(1) })
	.strict();
export const discoveryGraphResponseSchema = z
	.object({
		nodes: z.array(discoveryNoteSchema).max(30),
		edges: z.array(z.object({ from: discoveryPointerSchema, to: discoveryPointerSchema }).strict()).max(120),
		tags: z.array(z.object({ tag: z.string().max(80), count: z.number().int().positive() }).strict()).max(40),
		truncated: z.boolean(),
		warnings: z.array(z.string().max(80)).max(20),
		authority: z.literal("mutable_discovery_not_execution_approval"),
	})
	.strict();
export interface RuntimeKnowledgeDiscoveryApi {
	policy(caller: RuntimeCaller, workspaceId: string): Promise<z.infer<typeof discoveryPolicyViewSchema>>;
	savePolicy(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof discoveryPolicySaveSchema>,
	): Promise<z.infer<typeof discoveryPolicyViewSchema>>;
	saveCollection(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof discoveryCollectionSaveSchema>,
	): Promise<z.infer<typeof discoveryPolicyViewSchema>>;
	query(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof discoveryQuerySchema>,
	): Promise<z.infer<typeof discoveryQueryResponseSchema>>;
	read(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof discoveryReadSchema>,
	): Promise<z.infer<typeof discoveryReadResponseSchema>>;
	graph(
		caller: RuntimeCaller,
		workspaceId: string,
		input: z.infer<typeof discoveryGraphRequestSchema>,
	): Promise<z.infer<typeof discoveryGraphResponseSchema>>;
}
