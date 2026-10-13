import { describe, expect, it } from "vitest";

import { judgePassAgainstChecks } from "../../../src/pipeline/qa-checks-verdict";
import type { QaChecksAnswer, QaVerdict } from "../../../src/pipeline/qa-verdict";

function verdict(checks: QaChecksAnswer[], value: QaVerdict["verdict"] = "PASS"): QaVerdict {
	return {
		verdict: value,
		scores: null,
		blocking: [],
		visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
		notes: "ok",
		log: "",
		checks,
	};
}

const answer = (overrides: Partial<QaChecksAnswer> = {}): QaChecksAnswer => ({
	step: "test",
	reproduced: false,
	base: "passes",
	evidence: "npm test 3x green",
	...overrides,
});

describe("judgePassAgainstChecks (issue #41)", () => {
	it("leaves non-PASS verdicts and snapshots without failed steps alone", () => {
		expect(judgePassAgainstChecks(verdict([], "FAIL"), ["test"], "main")).toEqual({ kind: "ok" });
		expect(judgePassAgainstChecks(verdict([], "STALLED"), ["test"], "main")).toEqual({ kind: "ok" });
		expect(judgePassAgainstChecks(verdict([]), [], "main")).toEqual({ kind: "ok" });
		expect(judgePassAgainstChecks({ ...verdict([]), checks: undefined }, [], "main")).toEqual({ kind: "ok" });
	});

	it("accepts a step that didn't reproduce or fails on the base too, matched case-insensitively", () => {
		expect(judgePassAgainstChecks(verdict([answer()]), ["test"], "main")).toEqual({ kind: "ok" });
		expect(
			judgePassAgainstChecks(verdict([answer({ step: "Test", reproduced: true, base: "fails" })]), ["test"], "main"),
		).toEqual({ kind: "ok" });
	});

	it("calls a PASS incomplete when a step has no entry, no evidence or no conclusion", () => {
		expect(judgePassAgainstChecks(verdict([]), ["lint", "test"], "main")).toMatchObject({
			kind: "incomplete",
			missing: ["lint", "test"],
			error: expect.stringContaining("step(s) lint, test"),
		});
		expect(judgePassAgainstChecks(verdict([answer({ evidence: "" })]), ["test"], "main")).toMatchObject({
			kind: "incomplete",
			missing: ["test"],
		});
		expect(
			judgePassAgainstChecks(verdict([answer({ reproduced: null, base: "not_run" })]), ["test"], "main"),
		).toMatchObject({ kind: "incomplete", missing: ["test"] });
		expect(
			judgePassAgainstChecks(verdict([answer({ reproduced: true, base: "not_run" })]), ["test"], "main"),
		).toMatchObject({ kind: "incomplete" });
	});

	it("turns a PASS with a reproduced failure that passes on the base into a FAIL", () => {
		const judged = judgePassAgainstChecks(
			verdict([answer({ reproduced: true, base: "passes", evidence: "1 failed here, 0 on main" })]),
			["test"],
			"main",
		);
		expect(judged).toMatchObject({
			kind: "contradicted",
			changed: "PASS with reproduced checks failure(s) test → recorded as FAIL",
			verdict: {
				verdict: "FAIL",
				blocking: [
					"scripted checks step test fails on the snapshot and passes on main (QA reproduced it: 1 failed here, 0 on main)",
				],
			},
		});
	});
});
