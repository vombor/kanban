import { describe, expect, it } from "vitest";

import { describePipelineCardStage, describePipelineCardStageDetail } from "@/components/board-card-pipeline-stage";
import type { RuntimePipelineCardStage } from "@/runtime/types";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const BERLIN = { now: NOW, locale: "en-GB", timeZone: "Europe/Berlin" };

function stage(overrides: Partial<RuntimePipelineCardStage>): RuntimePipelineCardStage {
	return {
		taskId: "task-1",
		kind: "checks_running",
		label: "Checks running (test)",
		next: "QA next",
		qaTaskId: null,
		deadline: null,
		detail: null,
		detailTimes: [],
		inFlight: true,
		...overrides,
	};
}

describe("describePipelineCardStage", () => {
	it("shows the deadline in the viewer's time zone, with its date when it isn't today there", () => {
		expect(describePipelineCardStage(stage({ deadline: Date.parse("2026-10-13T05:03:00.000Z") }), BERLIN)).toBe(
			"Checks running (test) · QA next · until 07:03",
		);
		expect(describePipelineCardStage(stage({ deadline: Date.parse("2026-10-14T05:03:00.000Z") }), BERLIN)).toBe(
			"Checks running (test) · QA next · until 14 Oct, 07:03",
		);
	});
});

describe("describePipelineCardStageDetail", () => {
	it("shows the detail's UTC instants in the viewer's time zone and keeps its other words", () => {
		const detail = "held for r1 since 2026-10-13T05:03:00.000Z";
		expect(
			describePipelineCardStageDetail(
				stage({
					kind: "held",
					detail,
					detailTimes: [{ text: "2026-10-13T05:03:00.000Z", at: Date.parse("2026-10-13T05:03:00.000Z") }],
				}),
				BERLIN,
			),
		).toBe("held for r1 since 07:03");
		expect(describePipelineCardStageDetail(stage({ detail: "2 card(s) ahead" }), BERLIN)).toBe("2 card(s) ahead");
		expect(describePipelineCardStageDetail(stage({}), BERLIN)).toBeNull();
	});
});
