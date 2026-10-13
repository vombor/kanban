// QA waits for the scripted checks (user's choice "D", 2026-10-07): the QA gate creates a dev card's QA card only once
// the checks of its current snapshot have finished (PASS, FAIL or ERROR), or `pipeline.qa.checksWaitMin` has passed
// since the gate first waited for them, and the QA prompt gets their report (buildQaChecksReport). No QA slot is used
// while the checks run. A workspace without checks, or a snapshot whose package.json has none of the check scripts,
// gets its QA card right away and no report, as before.
//
// Before this, checks were queued with the QA card and QA ran without them: foo 27549 landed with only a checks
// ERROR (the export race fixed in 6c8248ca), and the only test gate was the QA agent.
//
// The wait is the dev card's `qaChecksWait` entry in pipeline-state.json (`{ snapshot, since }`); a new snapshot
// starts a new wait, and the checks runner stops a run on an older snapshot of the card (checks.ts).
//
// New (issue #41, notes 5bdde 2026-10-12: a PASS whose QA agent never ran the failing tests landed): for a FAIL the
// report asks QA for a "checks" answer per failed step in verdict.json, and the gate lands a PASS only when each one
// shows the step didn't reproduce or fails on the base too (qa-checks-verdict.ts).
import { CHECKS_VERSION, type StoredCheckStep, type StoredChecksResult } from "./checks";
import type { PipelineCardState } from "./pipeline-state";
import { QA_VERDICT_FILENAME } from "./qa-verdict";

export interface QaChecksWaitEntry {
	snapshot: string;
	since: number;
}

/**
 * - `off`: no checks for this snapshot (off for the workspace, or no check scripts); no wait, no report.
 * - `finished`: the checks of this snapshot are recorded (`checks` is null for a legacy-kit record without details).
 * - `waiting`: not recorded yet; QA waits until `deadline`.
 * - `timed_out`: still not recorded at the deadline; QA starts without them.
 */
export type QaChecksStatus =
	| { kind: "off"; reason: string }
	| { kind: "finished"; checks: StoredChecksResult | null }
	| { kind: "waiting"; since: number; deadline: number }
	| { kind: "timed_out"; since: number; waitMin: number };

/** What the QA card's gate entry keeps about the checks it was created with. */
export type QaChecksOutcome = StoredChecksResult["verdict"] | "timed_out" | "unknown" | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readQaChecksWait(entry: PipelineCardState | undefined): QaChecksWaitEntry | null {
	const wait = entry?.qaChecksWait;
	return isPlainObject(wait) && typeof wait.snapshot === "string" && typeof wait.since === "number"
		? { snapshot: wait.snapshot, since: wait.since }
		: null;
}

/**
 * When the gate's checks wait ends (`since` + `checksWaitMin`), or null without a wait (with `snapshot`: without one
 * for that snapshot). Past it the gate creates the QA card without the checks.
 */
export function readQaChecksWaitDeadline(
	entry: PipelineCardState | undefined,
	checksWaitMin: number,
	snapshot?: string | null,
): number | null {
	const wait = readQaChecksWait(entry);
	if (!wait || (snapshot !== undefined && wait.snapshot !== snapshot)) {
		return null;
	}
	return wait.since + checksWaitMin * 60_000;
}

/**
 * The checks recorded for this snapshot by the current checker: the result, `null` when the record has no details
 * (a legacy-kit checks-state.json entry), or `undefined` when this snapshot hasn't been checked.
 */
export function readRecordedChecks(
	entry: PipelineCardState | undefined,
	snapshot: string,
): StoredChecksResult | null | undefined {
	if (!entry || entry.snapshot !== snapshot || entry.version !== CHECKS_VERSION) {
		return undefined;
	}
	const checks = entry.checks;
	if (!isPlainObject(checks) || typeof checks.verdict !== "string") {
		return null;
	}
	return {
		...(checks as unknown as StoredChecksResult),
		steps: Array.isArray(checks.steps) ? (checks.steps as StoredCheckStep[]) : [],
	};
}

export interface DecideQaChecksInput {
	entry: PipelineCardState | undefined;
	snapshot: string;
	now: number;
	waitMin: number;
	/** Whether the workspace runs checks at all (resolveChecksEnabled). */
	enabled: boolean;
	/** The check scripts the snapshot has; only asked when the snapshot has no recorded checks yet. */
	readScripts: () => Promise<string[]>;
}

export async function decideQaChecks(input: DecideQaChecksInput): Promise<QaChecksStatus> {
	if (!input.enabled) {
		return { kind: "off", reason: "checks are off for this workspace" };
	}
	const recorded = readRecordedChecks(input.entry, input.snapshot);
	if (recorded !== undefined) {
		return { kind: "finished", checks: recorded };
	}
	if ((await input.readScripts()).length === 0) {
		return { kind: "off", reason: "the snapshot has no check scripts" };
	}
	const wait = readQaChecksWait(input.entry);
	const since = wait?.snapshot === input.snapshot ? wait.since : input.now;
	const deadline = since + input.waitMin * 60_000;
	return input.now >= deadline
		? { kind: "timed_out", since, waitMin: input.waitMin }
		: { kind: "waiting", since, deadline };
}

export function toQaChecksOutcome(status: QaChecksStatus): QaChecksOutcome {
	if (status.kind === "finished") {
		return status.checks?.verdict ?? "unknown";
	}
	return status.kind === "timed_out" ? "timed_out" : null;
}

/** For the decision log: what the QA card got, e.g. "checks FAIL", "checks timed out". */
export function describeQaChecksOutcome(outcome: QaChecksOutcome): string | null {
	if (outcome === null) {
		return null;
	}
	if (outcome === "timed_out") {
		return "checks timed out";
	}
	return outcome === "unknown" ? "checks recorded without details" : `checks ${outcome}`;
}

/**
 * The failed steps of a FAIL that a PASS must answer for (issue #41): failed or timed out, and not a harness problem
 * (the checker's environment, which the report already names as such). The QA gate entry keeps the same list.
 */
export function listBlockingFailedSteps(checks: StoredChecksResult | null): string[] {
	if (checks?.verdict !== "FAIL") {
		return [];
	}
	return checks.steps
		.filter((step) => (step.status === "fail" || step.status === "timeout") && !step.harness)
		.map((step) => step.name);
}

function formatSeconds(ms: number | null): string {
	return ms === null ? "" : ` in ${Math.max(0, Math.round(ms / 1000))}s`;
}

const STEP_STATUS: Record<StoredCheckStep["status"], string> = {
	ok: "ok",
	fail: "FAILED",
	timeout: "TIMED OUT",
	skipped: "skipped",
};

function formatStep(step: StoredCheckStep, timeoutMin: number | undefined): string[] {
	const timedOut = step.status === "timeout" && timeoutMin ? ` after ${timeoutMin} min` : "";
	const command = step.command ? ` (${step.command})` : "";
	const harness = step.harness ? "; harness problem: the checker's environment, not the code" : "";
	const head = `- ${step.name}: ${STEP_STATUS[step.status]}${timedOut}${step.status === "skipped" ? "" : formatSeconds(step.ms)}${command}${harness}`;
	const tail = Array.isArray(step.tail) ? step.tail : [];
	if (tail.length === 0) {
		return [head];
	}
	return [`${head}; the last ${tail.length} line(s) of its output:`, ...tail.map((line) => `    ${line}`)];
}

/**
 * The checks section appended to the QA prompt (buildQaPrompt's `checksReport`), or null when there were no checks.
 * An ERROR or a timeout says plainly that the checks did not run, so QA runs the scripts itself.
 */
export function buildQaChecksReport(input: {
	status: QaChecksStatus;
	snapshot: string;
	baseRef: string;
}): string | null {
	const { status } = input;
	const short = input.snapshot.slice(0, 8);
	const runYourself = "Run the typecheck/lint/test/build scripts yourself in step 2.";
	if (status.kind === "off" || status.kind === "waiting") {
		return null;
	}
	const intro = `SCRIPTED CHECKS of snapshot ${short}, run by the pipeline before this QA card started:`;
	if (status.kind === "timed_out") {
		return [
			intro,
			`- Result: TIMED OUT: the checks were still queued or running after ${status.waitMin} min, so they did NOT run in time and QA started without them. ${runYourself} Their result goes to the QA log when they finish.`,
		].join("\n");
	}
	const checks = status.checks;
	if (!checks) {
		return [
			intro,
			"- Result: checked earlier, but no details were recorded (see the QA log for the checks section of this snapshot).",
		].join("\n");
	}
	const lines = [intro];
	if (checks.verdict === "ERROR") {
		lines.push(
			`- Result: ERROR: the checker itself failed (${checks.error ?? "no reason given"}), so the checks did NOT run. ${runYourself}`,
		);
	} else {
		lines.push(`- Result: ${checks.verdict}${checks.logs ? ` (logs: ${checks.logs})` : ""}`);
	}
	for (const step of checks.steps) {
		lines.push(...formatStep(step, checks.timeoutMin));
	}
	if (checks.verdict === "FAIL") {
		lines.push(
			`A failed step is not blocking by itself: reproduce it in your scratch copy and compare against ${input.baseRef} (step 2) before you call it a blocking issue.`,
		);
		const failed = listBlockingFailedSteps(checks);
		if (failed.length > 0) {
			lines.push(
				`Add one more key to ${QA_VERDICT_FILENAME}: "checks", a list with one entry per failed step (${failed.join(", ")}): {"step": "<name>", "reproduced": true|false, "base": "fails"|"passes"|"not_run", "evidence": "<what you ran on the snapshot and on ${input.baseRef}, and what it showed>"}.`,
				`A PASS is accepted only when every failed step is listed with its evidence and either did not reproduce ("reproduced": false) or fails on ${input.baseRef} too ("base": "fails"). A step that fails on the snapshot and passes on ${input.baseRef} is a blocking issue. A PASS without these entries is not landed.`,
			);
		}
	} else if (checks.verdict === "PASS") {
		lines.push("You may rely on these results in step 2 instead of running the same scripts again.");
	}
	return lines.join("\n");
}
