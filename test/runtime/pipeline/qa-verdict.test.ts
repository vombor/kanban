import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	applyQaVerdictRules,
	buildQaVerdictNudge,
	createStalledQaVerdict,
	parseQaVerdictText,
	readQaVerdictFile,
} from "../../../src/pipeline/qa-verdict";
import { createTempDir } from "../../utilities/temp-dir";

describe("QA verdict.json", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	it("reads a full verdict and normalizes what is usable", () => {
		const read = parseQaVerdictText(
			JSON.stringify({
				verdict: "FAIL",
				scores: { spec: 3, correctness: 2, tests: 4, ux: null, code: 3, process: "5" },
				blocking: ["the badge never updates", { not: "text" }],
				visual: { status: "ok", artifacts: ["report.txt", 7], consoleErrors: 1 },
				notes: "one blocker",
				log: ["- blocker", "- concern"],
			}),
		);
		expect(read).toEqual({
			kind: "ok",
			verdict: {
				verdict: "FAIL",
				scores: { spec: 3, correctness: 2, tests: 4, ux: null, code: 3, process: null },
				blocking: ["the badge never updates", "[object Object]"],
				visual: { status: "ok", artifacts: ["report.txt"], consoleErrors: 1 },
				notes: "one blocker",
				log: "- blocker\n- concern",
			},
		});
	});

	it("keeps visual blocked when another visual field is malformed", () => {
		const read = parseQaVerdictText(
			JSON.stringify({
				verdict: "PASS",
				visual: { status: "blocked", artifacts: "report.txt", consoleErrors: "2" },
			}),
		);
		expect(read).toMatchObject({
			kind: "ok",
			verdict: { visual: { status: "blocked", artifacts: [], consoleErrors: 0 } },
		});
		if (read.kind === "ok") {
			expect(applyQaVerdictRules(read.verdict).verdict.verdict).toBe("STALLED");
		}
	});

	it("says why a file is unusable: invalid JSON (raw newlines, b9dd99b) or an unknown verdict", () => {
		expect(parseQaVerdictText('{"verdict":"PASS","log":"a\nb"}')).toMatchObject({
			kind: "invalid",
			error: expect.stringMatching(/^invalid JSON/u),
		});
		expect(parseQaVerdictText('{"verdict":"OK"}')).toEqual({
			kind: "invalid",
			error: '"verdict" must be one of PASS/FAIL/STALLED (got "OK")',
		});
	});

	it("reads the outbox file, missing when absent", async () => {
		const temp = createTempDir("kanban-qa-verdict-");
		temps.push(temp);
		const outbox = join(temp.path, "qa001");
		expect(await readQaVerdictFile(outbox)).toEqual({ kind: "missing" });
		mkdirSync(outbox, { recursive: true });
		writeFileSync(join(outbox, "verdict.json"), '{"verdict":"STALLED"}');
		expect(await readQaVerdictFile(outbox)).toMatchObject({
			kind: "ok",
			verdict: { verdict: "STALLED", blocking: [] },
		});
	});

	it("nudges with the reason, and records a PASS with visual blocked as STALLED", () => {
		expect(buildQaVerdictNudge("/out/qa001", { kind: "invalid", error: "invalid JSON (x)" }, "~/.kanban")).toBe(
			'/out/qa001/verdict.json exists but is not usable: invalid JSON (x). Rewrite it as valid JSON (escape newlines inside strings as \\n, or make "log" an array of strings). Then reply with the one-line summary. Don\'t run kanban commands or touch ~/.kanban.',
		);
		expect(buildQaVerdictNudge("/out/qa001", { kind: "missing" }, "~/.kanban")).toContain(
			"Your review isn't finished: write /out/qa001/verdict.json exactly as step 6 says",
		);
		const blocked = {
			...createStalledQaVerdict("x"),
			verdict: "PASS" as const,
			visual: { status: "blocked", artifacts: [], consoleErrors: 0 },
		};
		expect(applyQaVerdictRules(blocked)).toMatchObject({
			verdict: { verdict: "STALLED" },
			changed: expect.any(String),
		});
		const ok = { ...blocked, visual: { status: "ok", artifacts: [], consoleErrors: 0 } };
		expect(applyQaVerdictRules(ok)).toEqual({ verdict: ok, changed: null });
	});
});
