// A QA PASS on a snapshot whose scripted checks FAILed must answer for each failed step (issue #41). The checks
// report (qa-checks-report.ts) asks QA to reproduce every failed step and compare it with the base, and to say what
// it found in verdict.json's "checks" key. Before this nothing looked at the answer: notes' 5bdde (2026-10-12) landed
// on a PASS whose QA agent had run only lint and typecheck while the checks' `test` step had failed.
//
// A PASS is accepted when every failed step has an entry with evidence that either did not reproduce or fails on the
// base too (a pre-existing failure). A step QA reproduced that passes on the base is QA's own evidence of a regression,
// so that PASS is recorded as a FAIL. Anything else is incomplete: the gate nudges the QA card for it, and records a
// STALLED when the nudges are used up or no nudge is possible, never a PASS.
import type { QaChecksAnswer, QaVerdict } from "./qa-verdict";

export type QaPassChecksJudgement =
	| { kind: "ok" }
	/** `error` is what the nudge quotes. */
	| { kind: "incomplete"; missing: string[]; error: string }
	| { kind: "contradicted"; verdict: QaVerdict; changed: string };

function findAnswer(answers: QaChecksAnswer[], step: string): QaChecksAnswer | null {
	const wanted = step.toLowerCase();
	return answers.find((answer) => answer.step.toLowerCase() === wanted) ?? null;
}

export function judgePassAgainstChecks(
	verdict: QaVerdict,
	failedSteps: readonly string[],
	baseRef: string,
): QaPassChecksJudgement {
	if (verdict.verdict !== "PASS" || failedSteps.length === 0) {
		return { kind: "ok" };
	}
	const regressions: string[] = [];
	const missing: string[] = [];
	for (const step of failedSteps) {
		const answer = findAnswer(verdict.checks ?? [], step);
		if (answer?.reproduced === true && answer.base === "passes") {
			regressions.push(step);
		} else if (!answer?.evidence || (answer.reproduced !== false && answer.base !== "fails")) {
			missing.push(step);
		}
	}
	if (regressions.length > 0) {
		const blocking = regressions.map((step) =>
			`scripted checks step ${step} fails on the snapshot and passes on ${baseRef} (QA reproduced it: ${findAnswer(verdict.checks ?? [], step)?.evidence ?? ""})`.slice(
				0,
				2000,
			),
		);
		return {
			kind: "contradicted",
			verdict: {
				...verdict,
				verdict: "FAIL",
				blocking: [...blocking, ...verdict.blocking],
				notes: `PASS with a reproduced checks failure (${regressions.join(", ")}); ${verdict.notes}`.slice(0, 400),
			},
			changed: `PASS with reproduced checks failure(s) ${regressions.join(", ")} → recorded as FAIL`,
		};
	}
	if (missing.length > 0) {
		return {
			kind: "incomplete",
			missing,
			error: `the PASS doesn't answer for the failed scripted checks step(s) ${missing.join(", ")} (each needs a "checks" entry with evidence that it did not reproduce or fails on ${baseRef} too)`,
		};
	}
	return { kind: "ok" };
}
