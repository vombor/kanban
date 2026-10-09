import { describe, expect, it } from "vitest";

import { getTaskPrerequisiteLabel } from "@/utils/task-prerequisites-label";

describe("getTaskPrerequisiteLabel", () => {
	it("shows how many prerequisites a card still waits on", () => {
		expect(getTaskPrerequisiteLabel({ total: 3, done: 1, waitingOnTaskIds: ["a", "c"], missingTaskIds: [] })).toEqual(
			{
				text: "Waiting on 2 of 3",
				detail: "Waiting on a, c.",
				tone: "waiting",
			},
		);
	});

	it("flags a prerequisite deleted before Done, which keeps the card from starting by itself", () => {
		const label = getTaskPrerequisiteLabel({ total: 2, done: 1, waitingOnTaskIds: [], missingTaskIds: ["b"] });

		expect(label.text).toBe("Waiting on 1 of 2 (1 deleted)");
		expect(label.tone).toBe("blocked");
		expect(label.detail).toContain("Deleted before Done: b.");
	});

	it("says when every prerequisite is done", () => {
		expect(getTaskPrerequisiteLabel({ total: 2, done: 2, waitingOnTaskIds: [], missingTaskIds: [] })).toMatchObject({
			text: "All 2 prerequisites done",
			tone: "done",
		});
	});
});
