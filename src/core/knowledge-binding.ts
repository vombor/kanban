import { z } from "zod";
import { knowledgeRevisionSchema } from "../trpc/knowledge-contract";

/** Initial attachment identity, not a mutable "latest" pin. Adoption retains this root revision. */
export const knowledgeHandoffSchema = z.object({ rootRevision: knowledgeRevisionSchema }).strict();
export type KnowledgeHandoff = z.infer<typeof knowledgeHandoffSchema>;
