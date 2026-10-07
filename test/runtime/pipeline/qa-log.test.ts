import { describe, expect, it } from "vitest";

import { countQaLogRounds, formatQaLogSection, getPreviousQaRounds } from "../../../src/pipeline/qa-log";
import { createStalledQaVerdict } from "../../../src/pipeline/qa-verdict";

const LOG = [
	"# QA log",
	"## Claude QA d1111: FAIL (2026-10-06 10:00 UTC)\n- r1 blocker",
	"## Claude QA d11112: PASS (2026-10-06 10:01 UTC)\n- another card",
	"## Claude QA d1111 (round 2): FAIL (2026-10-06 11:00 UTC)\n- r2 blocker",
	"## ESCALATE d1111: needs human",
	"## Claude QA d1111 (round 3): FAIL (2026-10-06 12:00 UTC)\n- r3 blocker",
].join("\n\n");

describe("QA log", () => {
	it("counts a dev card's sections by heading, never another card's with the same prefix", () => {
		expect(countQaLogRounds(LOG, "d1111")).toBe(3);
		expect(countQaLogRounds(LOG, "d11112")).toBe(1);
		expect(countQaLogRounds("", "d1111")).toBe(0);
	});

	it("quotes the last two sections for the next round's prompt", () => {
		const previous = getPreviousQaRounds(LOG, "d1111");
		expect(previous).toBe(
			"## Claude QA d1111 (round 2): FAIL (2026-10-06 11:00 UTC)\n- r2 blocker\n\n## Claude QA d1111 (round 3): FAIL (2026-10-06 12:00 UTC)\n- r3 blocker",
		);
	});

	it("formats a section the legacy kit's heading parsers read", () => {
		const section = formatQaLogSection({
			devTaskId: "d1111",
			round: 2,
			verdict: createStalledQaVerdict("QA agent stopped without a verdict.json"),
			at: Date.parse("2026-10-07T09:05:30Z"),
			dev: { agentId: "cline", model: { provider: "bedrock", model: "us.openai.gpt-6.1-sol" } },
			reviewer: { qaTaskId: "qa001", agentId: "codex", model: null },
			artifactsDir: "/home/data/foo/qa-artifacts/d1111/r2",
			verdictPath: "/tmp/kanban-qa-out/qa001/verdict.json",
			pipelineNote: "2 nudge(s) used",
		});
		expect(section.split("\n")).toEqual([
			"## Claude QA d1111 (round 2): STALLED (2026-10-07 09:05 UTC)",
			"- QA agent stopped without a verdict.json (the pipeline recorded STALLED).",
			"- Dev: cline on bedrock/us.openai.gpt-6.1-sol",
			"- Visual: n/a; card-caused console errors: 0",
			"- Scores: n/a",
			"- Pipeline: 2 nudge(s) used",
			"- Reviewer: codex on its default model, QA card qa001; ingested by Kanban from /tmp/kanban-qa-out/qa001/verdict.json",
		]);
		expect(countQaLogRounds(section, "d1111")).toBe(1);
	});
});
