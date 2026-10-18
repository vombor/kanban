import { z } from "zod";

export const objectiveReservationSchema = z
	.object({
		id: z.string().uuid(),
		taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u),
		requirementsHash: z.string().regex(/^[a-f0-9]{64}$/u),
		kind: z.enum(["start", "input"]),
		at: z.string().datetime({ offset: true }),
		state: z.enum(["reserved", "started", "released", "uncertain"]),
		startedAt: z.number().nonnegative().nullable(),
		report: z.array(z.enum(["attempt_limit", "time_limit", "cost_limit", "cost_unknown"])).max(4),
	})
	.strict();
export type ObjectiveReservation = z.infer<typeof objectiveReservationSchema>;
export const objectiveAdmissionReasonSchema = z.enum([
	"user_paused",
	"attempt_limit",
	"time_limit",
	"cost_limit",
	"cost_unknown",
	"delivery_uncertain",
	"enforcement_unavailable",
]);
export const objectiveControlSchema = z
	.object({
		id: z.string().uuid(),
		at: z.string().datetime({ offset: true }),
		action: z.enum(["pause", "resume", "override", "acknowledge", "revoke"]),
		reason: z.string().trim().min(1).max(1000),
		taskId: z.string().min(1).max(80).nullable(),
		kind: z.enum(["start", "input"]).nullable(),
		reservationId: z.string().uuid().nullable(),
		controlId: z.string().uuid().nullable().default(null),
		revokedBy: z.string().uuid().nullable().default(null),
		requirementsHash: z.string().regex(/^[a-f0-9]{64}$/u),
		limitsHash: z.string().regex(/^[a-f0-9]{64}$/u),
		usedBy: z.string().uuid().nullable(),
	})
	.strict();
export type ObjectiveControl = z.infer<typeof objectiveControlSchema>;
export interface ObjectiveAdmissionDecision {
	bound: boolean;
	allowed: boolean;
	reason: z.infer<typeof objectiveAdmissionReasonSchema> | null;
}
/** Narrow in-process runtime boundary. No prompts, credentials, models, terminal or server types. */
export interface ObjectiveAdmissionAccounting {
	check?(workspaceId: string, taskId: string, kind: ObjectiveReservation["kind"]): Promise<ObjectiveAdmissionDecision>;
	reserve(
		workspaceId: string,
		taskId: string,
		id: string,
		kind: ObjectiveReservation["kind"],
	): Promise<{ id: string; duplicate: boolean } | null>;
	settle(
		workspaceId: string,
		id: string,
		state: "started" | "released" | "uncertain",
		startedAt?: number | null,
	): Promise<void>;
}
