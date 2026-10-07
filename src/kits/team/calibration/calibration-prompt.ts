// A calibration card's title and prompt: the pipeline's QA prompt (src/pipeline/qa-prompt.ts, the same skeleton real
// QA cards get) with a calibration intro, on the set's ref instead of a card snapshot. Title and intro keep the legacy
// kit's shapes ("QA-CAL …", "You are the QA reviewer (calibration …"), which resolveCardRole() still reads on cards
// that predate `role`.
//
// Ported from archive/devteam-kit:qa/calibrate.mjs@94247a7 (createRun, stripRework).

import { buildQaPrompt, buildQaRequirements } from "../../../pipeline/qa-prompt";
import type { QaPromptParts } from "../../policy";
import type { CalibrationRunPlan, CalibrationSpec } from "./calibration-spec";

/** A REWORK round appended to a dev prompt (up to its FINAL STEP): QA judges the card's own requirements. */
export function stripReworkSections(prompt: string): string {
	return prompt.replace(/\n+REWORK round[\s\S]*?(?=\n+FINAL STEP|$)/gu, "");
}

function describeSet(run: CalibrationRunPlan): string {
	return run.set.note ?? run.set.fromCard;
}

export function buildCalibrationCardTitle(run: CalibrationRunPlan): string {
	return `QA-CAL ${run.set.id} ${run.model.key}: ${describeSet(run)}`.slice(0, 80);
}

export function buildCalibrationPrompt(input: {
	spec: CalibrationSpec;
	run: CalibrationRunPlan;
	devPrompt: string;
	repoPath: string;
	snapshotRef: string;
	scratchDir: string;
	outboxDir: string;
	parts: QaPromptParts;
	kanbanHome: string;
}): string {
	const { run } = input;
	return buildQaPrompt({
		devTaskId: run.set.fromCard,
		round: 1,
		devTitle: describeSet(run),
		requirements: buildQaRequirements(stripReworkSections(input.devPrompt), input.parts.blurb),
		repoPath: input.repoPath,
		snapshotRef: input.snapshotRef,
		baseRef: run.set.base,
		scratchDir: input.scratchDir,
		outboxDir: input.outboxDir,
		previousRounds: "",
		parts: input.parts,
		kanbanHome: input.kanbanHome,
		intro: `You are the QA reviewer (calibration ${input.spec.name} ${run.key}) for a Kanban dev card ("${describeSet(run)}")`,
	});
}
