import { describe, expect, it } from "vitest";
import type { RuntimeProjectSummary } from "@/runtime/types";
import {
	formatOrchestratorWaitNotificationTitle,
	listWaitingProjects,
	takeNewOrchestratorWaits,
} from "@/utils/orchestrator-wait-alerts";

function project(
	id: string,
	orchestratorWait: RuntimeProjectSummary["orchestratorWait"] = null,
): RuntimeProjectSummary {
	return {
		id,
		name: `${id}-app`,
		path: `/projects/${id}-app`,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		orchestratorWait,
	};
}

describe("orchestrator wait alerts", () => {
	it("lists the waiting projects with one key per pending request", () => {
		const waiting = listWaitingProjects([
			project("alpha", { kind: "question", since: 10 }),
			project("beta"),
			project("gamma", { kind: "approval", since: 20 }),
		]);
		expect(waiting.map((entry) => entry.key)).toEqual(["alpha:question:10", "gamma:approval:20"]);
	});

	it("takes each request once: a wait that clears and comes back with the same start is not new", () => {
		const first = takeNewOrchestratorWaits(
			[],
			listWaitingProjects([project("alpha", { kind: "question", since: 10 })]),
		);
		expect(first.added.map((entry) => entry.project.id)).toEqual(["alpha"]);

		const cleared = takeNewOrchestratorWaits(first.seenKeys, listWaitingProjects([project("alpha")]));
		expect(cleared.added).toEqual([]);
		const back = takeNewOrchestratorWaits(
			cleared.seenKeys,
			listWaitingProjects([project("alpha", { kind: "question", since: 10 })]),
		);
		expect(back.added).toEqual([]);

		// The same session's next request starts later: it is new.
		const next = takeNewOrchestratorWaits(
			back.seenKeys,
			listWaitingProjects([project("alpha", { kind: "approval", since: 30 })]),
		);
		expect(next.added.map((entry) => entry.key)).toEqual(["alpha:approval:30"]);
	});

	it("keeps the seen keys bounded", () => {
		let seenKeys: string[] = [];
		for (let since = 0; since < 250; since += 1) {
			seenKeys = takeNewOrchestratorWaits(
				seenKeys,
				listWaitingProjects([project("alpha", { kind: "question", since })]),
			).seenKeys;
		}
		expect(seenKeys).toHaveLength(200);
		expect(seenKeys.at(-1)).toBe("alpha:question:249");
	});

	it("names the project and what it waits for", () => {
		expect(formatOrchestratorWaitNotificationTitle("notes", "question")).toBe(
			"notes: the Kanban Agent has a question for you",
		);
		expect(formatOrchestratorWaitNotificationTitle("notes", "approval")).toBe(
			"notes: the Kanban Agent needs your approval",
		);
	});
});
