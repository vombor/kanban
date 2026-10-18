import { afterEach, describe, expect, it } from "vitest";
import { addWakeRequest, checkWakeRequests, readWakeRequests } from "../../../../src/pipeline/watchdog/wake-requests";
import { createWatchdogHarness, WATCHDOG_NOW } from "../../../utilities/watchdog";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

describe("when-card-done uses current board evidence (issue #67)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});
	it("keeps a newly started card's request despite a stale pre-creation snapshot, then fires on actual Done", async () => {
		let current = createBoard({ in_progress: [createCard({ id: "cd33c" })] });
		const harness = createWatchdogHarness({
			config: { watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } },
			readWakeBoard: async () => current,
		});
		cleanups.push(harness.cleanup);
		const path = harness.paths("project").wakeRequests;
		const request = await addWakeRequest(path, {
			issue: "bounded completion audit",
			when: { kind: "card-done", taskId: "cd33c" },
			timeoutMin: 2,
			now: new Date(WATCHDOG_NOW),
		});
		harness.observe({ workspaceId: "project", board: createBoard({}) });
		await harness.watchdog.tick();
		expect((await readWakeRequests(path)).map((item) => item.id)).toEqual([request.id]);
		expect(
			harness.requests.some((item) => item.kind === "startOrchestratorSession" || item.kind === "deliverInput"),
		).toBe(false);
		current = createBoard({ trash: [createCard({ id: "cd33c" })] });
		await harness.watchdog.tick();
		expect(await readWakeRequests(path)).toEqual([]);
		expect(
			harness.requests.some(
				(item) => item.kind === "startOrchestratorSession" && item.prompt.includes("bounded completion audit"),
			),
		).toBe(true);
	});
	it("does not turn unreadable current state into deletion; its timeout remains bounded and honest", async () => {
		const request = {
			id: "request",
			createdAt: new Date(WATCHDOG_NOW).toISOString(),
			issue: "audit",
			when: { kind: "card-done" as const, taskId: "cd33c" },
			timeoutMin: 2,
			lastProbeAt: null,
			upSince: null,
		};
		const input = {
			requests: [request],
			board: createBoard({}),
			readBoard: async () => {
				throw new Error("unreadable");
			},
			probe: async () => false,
		};
		const early = await checkWakeRequests({ ...input, now: WATCHDOG_NOW + 1000 });
		expect(early.remaining).toEqual([request]);
		expect(early.items).toEqual([]);
		const expired = await checkWakeRequests({ ...input, now: WATCHDOG_NOW + 120001 });
		expect(expired.remaining).toEqual([]);
		expect(expired.items[0]).toContain("timed out");
		expect(expired.log[0]).toContain("unknown");
		expect(expired.log[0]).not.toContain("gone");
	});
});
