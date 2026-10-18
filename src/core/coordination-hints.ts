import { z } from "zod";
import { hasControlCharacters } from "../trpc/knowledge-contract";

const label = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.refine((value) => !hasControlCharacters(value));
/** Ownership is a reviewed hint, never a file permission, write lock or dependency. */
export const coordinationPathSchema = z
	.string()
	.min(1)
	.max(240)
	.refine(
		(value) =>
			!hasControlCharacters(value) &&
			!/[\\:*?]/u.test(value) &&
			!value.startsWith("/") &&
			value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.endsWith(" ")),
	);
export const coordinationHintsSchema = z
	.object({
		paths: z.array(coordinationPathSchema).max(20).default([]),
		produces: z.array(label).max(10).default([]),
		consumes: z.array(label).max(10).default([]),
		risk: z.enum(["low", "medium", "high"]).optional(),
		taskType: label.optional(),
	})
	.strict();
export type CoordinationHints = z.infer<typeof coordinationHintsSchema>;
