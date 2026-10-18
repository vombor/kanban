// Agent-neutral runtime contracts. No maintainer/Desktop OpenCode/server implementation imports.
import { z } from "zod";
import {
	objectiveAdmissionReasonSchema,
	objectiveControlSchema,
	objectiveReservationSchema,
} from "./objective-admission";
import { objectiveEvidenceSchema } from "./objective-evidence";
import { createObjectiveTaskLineage } from "./objective-task-lineage";
import { objectiveUsageRecordSchema } from "./objective-usage";

export const objectiveIdSchema = z.string().regex(/^obj-[a-f0-9-]{36}$/u);
export const objectiveHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const objectiveTaskIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u);
export const objectiveLimitsSchema = z
	.object({
		mode: z.enum(["report", "enforce"]).default("report"),
		maxAttempts: z.number().int().positive().nullable().default(null),
		maxElapsedMinutes: z.number().positive().nullable().default(null),
		maxEstimatedUsd: z.number().nonnegative().nullable().default(null),
		unknownCost: z.enum(["hold", "allow"]).default("hold"),
	})
	.strict();
export type ObjectiveLimits = z.infer<typeof objectiveLimitsSchema>;

export const objectivePolicySchema = z
	.object({
		requiredChecks: z
			.array(z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/u))
			.min(1)
			.max(20)
			.default(["test"]),
		requireQa: z.boolean().default(true),
		completion: z.literal("landed").default("landed"),
	})
	.strict();
export const objectiveTaskSchema = z
	.object({
		taskId: objectiveTaskIdSchema,
		kind: z.enum(["dev", "qa", "rework", "escalation", "runoff"]),
		parentTaskId: objectiveTaskIdSchema.nullable(),
		attachedAt: z.string().datetime({ offset: true }),
	})
	.strict();
export const objectiveAttemptSchema = z
	.object({
		id: objectiveHashSchema,
		taskId: objectiveTaskIdSchema,
		startedAt: z.string().datetime({ offset: true }),
		/** Session run identity and monotonic observation clock; absent only in pre-observer state. */
		runStartedAt: z.string().datetime({ offset: true }).optional(),
		lastObservedAt: z.string().datetime({ offset: true }).optional(),
		endedAt: z.string().datetime({ offset: true }).nullable(),
		requirementsHash: objectiveHashSchema,
		snapshot: z
			.string()
			.regex(/^[a-f0-9]{40,64}$/u)
			.nullable(),
		state: z.enum(["running", "settled", "interrupted", "unknown"]),
		executionBlocked: z.boolean().optional(),
	})
	.strict();
export const objectiveHandoffSchema = z
	.object({
		code: z.enum([
			"evidence_missing",
			"evidence_stale",
			"checks_failed",
			"qa_failed",
			"qa_stalled",
			"landing_missing",
			"attempt_limit",
			"time_limit",
			"cost_limit",
			"cost_unknown",
			"delivery_uncertain",
			"user_paused",
			"execution_blocked",
		]),
		owner: z.enum(["checks", "qa", "landing", "recovery", "user", "supervision"]),
		action: z.enum([
			"wait_for_evidence",
			"inspect_checks",
			"inspect_qa",
			"resolve_landing",
			"review_limit",
			"confirm_delivery",
			"resume",
			"inspect_execution",
		]),
		taskId: objectiveTaskIdSchema.nullable(),
		since: z.string().datetime({ offset: true }),
	})
	.strict();
export const objectiveSchema = z
	.object({
		id: objectiveIdSchema,
		title: z.string().trim().min(1).max(160),
		createdAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
		revision: z.number().int().positive(),
		requirementsHash: objectiveHashSchema,
		policy: objectivePolicySchema,
		limits: objectiveLimitsSchema,
		tasks: z.array(objectiveTaskSchema).min(1).max(500),
		attempts: z.array(objectiveAttemptSchema).max(2000),
		evidence: z.array(objectiveEvidenceSchema).max(4000).default([]),
		usage: z.array(objectiveUsageRecordSchema).max(10000).default([]),
		reservations: z.array(objectiveReservationSchema).max(4000).default([]),
		controls: z.array(objectiveControlSchema).max(4000).default([]),
		/** Conservative observed subtotal (highest retained estimate per source); never complete total coverage. */
		observedEstimatedUsd: z.number().nonnegative().nullable().default(null),
		pausedByUser: z.boolean().default(false),
		status: z.enum(["awaiting_evidence", "running", "held", "completed"]),
		handoff: objectiveHandoffSchema.nullable(),
		estimatedUsd: z.number().nonnegative().nullable(),
		costCoverage: z.enum(["unknown", "partial", "complete"]),
		finalCommits: z.array(z.string().regex(/^[a-f0-9]{40,64}$/u)).max(500),
	})
	.strict()
	.superRefine((objective, context) => {
		try {
			createObjectiveTaskLineage(objective.tasks);
		} catch {
			context.addIssue({
				code: "custom",
				path: ["tasks"],
				message: "Invalid objective task lineage; preserve state and repair its explicit parent links.",
			});
		}
	});
export type RuntimeObjective = z.infer<typeof objectiveSchema>;

export const objectiveCreateSchema = z
	.object({
		requestId: z.string().uuid(),
		title: z.string().trim().min(1).max(160),
		requirements: z.string().trim().min(1).max(32_768),
		taskIds: z.array(objectiveTaskIdSchema).min(1).max(100),
		policy: objectivePolicySchema.default(() => objectivePolicySchema.parse({})),
		limits: objectiveLimitsSchema.default(() => objectiveLimitsSchema.parse({})),
		acknowledgeAdmissionScope: z.boolean().optional(),
	})
	.strict();
export type ObjectiveCreate = z.infer<typeof objectiveCreateSchema>;
export const objectiveReadSchema = z.object({ id: objectiveIdSchema }).strict();
export const objectiveListSchema = z
	.object({ offset: z.number().int().min(0).max(1000).default(0), limit: z.number().int().min(1).max(50).default(20) })
	.default({ offset: 0, limit: 20 });
export const objectiveListResponseSchema = z.object({
	objectives: z.array(objectiveSchema),
	total: z.number().int(),
	nextOffset: z.number().int().nullable(),
});
export const objectiveReadResponseSchema = z.object({
	objective: objectiveSchema,
	requirements: z.string().max(32_768),
	handoffGuide: z
		.object({
			summary: z.string().max(1000),
			owner: objectiveHandoffSchema.shape.owner,
			commands: z.array(z.array(z.string().max(256)).max(12)).max(3),
			executionEnforcementAvailable: z.boolean(),
		})
		.nullable()
		.default(null),
	admissionScopeAvailable: z.boolean().default(false),
	admissionStates: z
		.array(
			z
				.object({
					taskId: objectiveTaskIdSchema,
					kind: z.enum(["start", "input"]),
					allowed: z.boolean(),
					reason: objectiveAdmissionReasonSchema.nullable(),
				})
				.strict(),
		)
		.max(1000)
		.default([]),
});
export type ObjectiveReadResponse = z.infer<typeof objectiveReadResponseSchema>;
export const objectiveLimitsRequestSchema = z
	.object({
		requestId: z.string().uuid(),
		id: objectiveIdSchema,
		expectedRevision: z.number().int().positive(),
		limits: objectiveLimitsSchema,
		acknowledgeAdmissionScope: z.boolean().optional(),
	})
	.strict();
export type ObjectiveLimitsChange = z.infer<typeof objectiveLimitsRequestSchema>;

export const objectiveManualLineageSchema = z
	.object({
		requestId: z.string().uuid(),
		id: objectiveIdSchema,
		expectedRevision: z.number().int().positive(),
		parentTaskId: objectiveTaskIdSchema,
		kind: z.enum(["rework", "escalation", "runoff"]),
		taskIds: z.array(objectiveTaskIdSchema).min(1).max(100),
		/** Planned ids may be reserved before creation. Existing ids must be unstarted Backlog dev tasks. */
		planned: z.boolean().default(false),
	})
	.strict();
export type ObjectiveManualLineage = z.infer<typeof objectiveManualLineageSchema>;
export const objectiveControlRequestSchema = z
	.object({
		requestId: z.string().uuid(),
		id: objectiveIdSchema,
		expectedRevision: z.number().int().positive(),
		action: objectiveControlSchema.shape.action,
		reason: objectiveControlSchema.shape.reason,
		taskId: objectiveTaskIdSchema.nullable().default(null),
		kind: z.enum(["start", "input"]).nullable().default(null),
		reservationId: z.string().uuid().nullable().default(null),
		controlId: z.string().uuid().nullable().default(null),
	})
	.strict()
	.superRefine((input, context) => {
		const invalid =
			input.action === "revoke"
				? !input.controlId || input.taskId !== null || input.kind !== null || input.reservationId !== null
				: input.controlId !== null ||
					(input.action === "override"
						? !input.taskId || !input.kind || input.reservationId !== null
						: input.action === "acknowledge"
							? !input.reservationId || input.taskId !== null || input.kind !== null
							: input.taskId !== null || input.kind !== null || input.reservationId !== null);
		if (invalid)
			context.addIssue({
				code: "custom",
				message: "Control targets must match their explicit action; no broad override is supported.",
			});
	});
export type ObjectiveControlRequest = z.infer<typeof objectiveControlRequestSchema>;
