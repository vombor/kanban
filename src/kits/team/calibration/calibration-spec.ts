// A calibration spec: the same QA review run on fixed snapshots ("sets", each with a known expected verdict) by
// several QA models, to compare QA models against known answers. The format is the legacy kit's, so its specs in
// `data/<ws>/calibration/*/spec.json` still run.
//
// Ported from archive/devteam-kit:qa/calibrate.mjs@94247a7 (the spec in its header; maxNudges 8ffce60, loopRepeats and
// maxCostUSD ce7b672).
import { z } from "zod";

import { runtimeAgentIdSchema } from "../../../core/api-contract";

/** Names that end up in paths and git refs (`refs/kanban/calibration/<name>-<set>`). */
const calibrationIdSchema = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "use letters, digits, '.', '_' and '-'");

const calibrationSetSchema = z
	.object({
		id: calibrationIdSchema,
		/** The commit with the work under review. */
		ref: z.string().trim().min(1),
		/** The commit it branched from (the QA diff is base...ref). */
		base: z.string().trim().min(1),
		/** The dev card whose prompt holds the requirements (live board, else a board backup). */
		fromCard: z.string().trim().min(1),
		/** The known answer: FAIL | PASS | ? (only shown in results.md, for the judge). */
		expect: z.string().optional(),
		note: z.string().optional(),
	})
	.loose();

const calibrationModelSchema = z
	.object({
		key: calibrationIdSchema,
		agent: runtimeAgentIdSchema,
		provider: z.string().trim().min(1).optional(),
		model: z.string().trim().min(1).optional(),
		/** Names of the kit's `qa.rules` texts added to the QA prompt (e.g. `drive`). */
		rules: z.array(z.string()).default([]),
	})
	.loose();

export const calibrationSpecSchema = z
	.object({
		name: calibrationIdSchema,
		/** Workspace id or project path; `--project` wins. */
		workspace: z.string().trim().min(1).optional(),
		/** Runs at a time (one wave). */
		parallel: z.number().int().positive().default(3),
		timeoutMin: z.number().positive().default(75),
		/** Continue-nudges for a card that stops without a verdict. */
		maxNudges: z.number().int().nonnegative().default(2),
		/** DNF when one tool call fills this many of the last 60 calls. */
		loopRepeats: z.number().int().positive().default(25),
		/** DNF when a run's cost passes this (checked every 5 min). */
		maxCostUSD: z.number().positive().default(10),
		sets: z.array(calibrationSetSchema).min(1),
		models: z.array(calibrationModelSchema).min(1),
	})
	.loose()
	.superRefine((spec, context) => {
		for (const [field, ids] of [
			["sets", spec.sets.map((set) => set.id)],
			["models", spec.models.map((model) => model.key)],
		] as const) {
			const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
			if (duplicate) {
				context.addIssue({ code: "custom", path: [field], message: `"${duplicate}" is listed twice` });
			}
		}
	});

export type CalibrationSpec = z.infer<typeof calibrationSpecSchema>;
export type CalibrationSet = CalibrationSpec["sets"][number];
export type CalibrationModel = CalibrationSpec["models"][number];

export interface CalibrationRunPlan {
	/** `<set id>-<model key>`, the run's key in state.json. */
	key: string;
	set: CalibrationSet;
	model: CalibrationModel;
}

export function parseCalibrationSpec(raw: unknown): CalibrationSpec {
	const parsed = calibrationSpecSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`invalid calibration spec: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
		);
	}
	return parsed.data;
}

/**
 * Every run, set by set: the waves of `parallel` runs then go one set at a time across all models, so the models
 * review the same work under the same machine load.
 */
export function listCalibrationRuns(spec: CalibrationSpec): CalibrationRunPlan[] {
	return spec.sets.flatMap((set) => spec.models.map((model) => ({ key: `${set.id}-${model.key}`, set, model })));
}

/** The ref the runner points at a set's commit, so QA reads the work from a ref as it does for a real card. */
export function getCalibrationSetRef(spec: CalibrationSpec, set: CalibrationSet): string {
	return `refs/kanban/calibration/${spec.name}-${set.id}`;
}
