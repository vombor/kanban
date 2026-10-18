import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute, "Expected an absolute operator-owned path");
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const jobIdSchema = z.string().regex(/^maint-[a-f0-9]{32}$/u);
const stamp = z.string().datetime({ offset: true });
export const reasonSchema = z.enum([
	"scope",
	"acceptance",
	"permission",
	"tooling",
	"provider",
	"user_input",
	"unknown",
]);
export const workerStageSchema = z.enum([
	"investigating",
	"implementing",
	"testing",
	"reviewing",
	"publishing",
	"blocked",
]);

export const maintenanceConfigSchema = z
	.object({
		version: z.literal(1),
		repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
		projectDirectory: absolutePath,
		branch: z
			.string()
			.regex(/^[A-Za-z0-9_./-]+$/u)
			.max(200),
		sessionId: z.string().regex(/^ses[A-Za-z0-9_]+$/u),
		opencodeCli: absolutePath,
		githubBridge: z.object({ executable: absolutePath, args: z.array(z.string().max(4096)).max(10) }).strict(),
		timezone: z.string().min(1).max(80),
		requiredWorkflows: z
			.array(z.string().regex(/^[A-Za-z0-9_.-]+\.ya?ml$/u))
			.min(1)
			.max(10),
		maxJobHours: z.number().positive().max(168).default(24),
		maxJobs: z.number().int().min(1).max(1000).default(500),
	})
	.strict();
export type MaintenanceConfig = z.infer<typeof maintenanceConfigSchema>;

export const issueSnapshotSchema = z
	.object({
		number: z.number().int().positive(),
		materialHash: digestSchema,
		comments: z.array(z.object({ id: z.string().max(200), hash: digestSchema }).strict()).max(1000),
	})
	.strict();
export type IssueSnapshot = z.infer<typeof issueSnapshotSchema>;

export const workerProgressSchema = z
	.object({
		version: z.literal(1),
		jobId: jobIdSchema,
		stage: workerStageSchema,
		reason: reasonSchema.optional(),
	})
	.strict();
export const workerResultSchema = z
	.object({
		version: z.literal(1),
		jobId: jobIdSchema,
		startingCommit: commitShaSchema,
		issues: z
			.array(
				z.discriminatedUnion("disposition", [
					z
						.object({
							number: z.number().int().positive(),
							disposition: z.literal("fixed"),
							commits: z.array(commitShaSchema).min(1).max(20),
						})
						.strict(),
					z
						.object({
							number: z.number().int().positive(),
							disposition: z.literal("blocked"),
							reason: reasonSchema,
						})
						.strict(),
				]),
			)
			.min(1)
			.max(100),
	})
	.strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const jobStateSchema = z.enum([
	"prepared",
	"submitting",
	"admission_unknown",
	"queued",
	"running",
	"awaiting_evidence",
	"verifying",
	"blocked",
	"completed",
]);
export const maintenanceJobSchema = z
	.object({
		id: jobIdSchema,
		targetHash: digestSchema,
		repository: z.string(),
		sessionId: z.string(),
		day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
		startingCommit: commitShaSchema,
		issues: z.array(issueSnapshotSchema).min(1).max(100),
		inputId: z.string().regex(/^msg_/u).max(120),
		createdAt: stamp,
		updatedAt: stamp,
		state: jobStateSchema,
		workerStage: workerStageSchema.optional(),
		reason: z.string().max(100).optional(),
		resultDigest: digestSchema.optional(),
		verificationDigest: digestSchema.optional(),
		commits: z.array(commitShaSchema).max(100).default([]),
		ciUrls: z.array(z.string().url().max(500)).max(100).default([]),
		closedIssues: z.array(z.number().int().positive()).max(100).default([]),
	})
	.strict();
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;

export const journalSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		jobs: z.array(maintenanceJobSchema).max(1000),
		checks: z
			.array(
				z
					.object({
						targetHash: digestSchema,
						day: z.string(),
						at: stamp,
						outcome: z.enum(["no_work", "admitted", "held"]),
						source: z.enum(["native", "legacy_no_work"]).optional(),
						jobId: jobIdSchema.optional(),
					})
					.strict(),
			)
			.max(4000),
		events: z
			.array(
				z
					.object({ at: stamp, jobId: jobIdSchema, state: jobStateSchema, reason: z.string().max(100).optional() })
					.strict(),
			)
			.max(10000),
	})
	.strict();
export type MaintenanceJournal = z.infer<typeof journalSchema>;

export interface ExecutionObservation {
	queued: boolean;
	delivered: boolean;
	active: boolean;
	failed: boolean;
	interrupted: boolean;
	completeTurn: boolean;
	scopedTurn: boolean;
}

export const verificationSchema = z
	.object({
		issues: z
			.array(
				z
					.object({
						number: z.number().int().positive(),
						closed: z.boolean(),
						materialMatches: z.boolean(),
						linkedResolution: z.boolean(),
					})
					.strict(),
			)
			.max(100),
		commits: z
			.array(
				z
					.object({
						sha: commitShaSchema,
						descendedFromStart: z.boolean(),
						pushed: z.boolean(),
						ci: z.enum(["pending", "passed", "failed", "missing"]),
						urls: z.array(z.string().url().max(500)).max(10),
					})
					.strict(),
			)
			.max(100),
	})
	.strict();
export type Verification = z.infer<typeof verificationSchema>;
