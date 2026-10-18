import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const snapshot = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const objectiveBindingSchema = z
	.object({
		objectiveId: z.string().regex(/^obj-[a-f0-9-]{36}$/u),
		requirementsHash: hash,
		policyHash: hash,
	})
	.strict();
export type ObjectiveBinding = z.infer<typeof objectiveBindingSchema>;
export const objectiveLineageSchema = z
	.object({
		binding: objectiveBindingSchema,
		taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u),
		parentTaskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u),
		kind: z.enum(["qa", "escalation", "runoff"]),
		at: z.string().datetime({ offset: true }),
	})
	.strict();
export type ObjectiveLineage = z.infer<typeof objectiveLineageSchema>;
const fields = {
	id: hash,
	taskId: z.string().min(1).max(80),
	binding: objectiveBindingSchema,
	at: z.string().datetime({ offset: true }),
	snapshot,
};
export const objectiveEvidenceSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...fields,
			kind: z.literal("checks"),
			scripts: z
				.array(
					z
						.object({
							name: z.string().max(80),
							status: z.enum(["pass", "fail", "unknown"]),
							harness: z.boolean(),
						})
						.strict(),
				)
				.max(30),
		})
		.strict(),
	z
		.object({
			...fields,
			kind: z.literal("qa"),
			qaTaskId: z.string().min(1).max(80),
			verdict: z.enum(["PASS", "FAIL", "STALLED"]),
		})
		.strict(),
	z.object({ ...fields, kind: z.literal("landed"), commit: snapshot, baseRef: z.string().min(1).max(256) }).strict(),
]);
export type ObjectiveEvidence = z.infer<typeof objectiveEvidenceSchema>;

/** In-process owner boundary, never an agent-facing evidence submission API. */
export interface ObjectiveEvidenceOwner {
	attach(workspaceId: string, input: ObjectiveLineage): Promise<void>;
	capture(workspaceId: string, taskId: string): Promise<{ binding: ObjectiveBinding; requirements: string } | null>;
	record(workspaceId: string, evidence: ObjectiveEvidence): Promise<void>;
}
