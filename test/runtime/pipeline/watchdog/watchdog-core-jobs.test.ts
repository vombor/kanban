import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { addWakeRequest } from "../../../../src/pipeline/watchdog/wake-requests";
import { createWatchdogHarness, WATCHDOG_NOW } from "../../../utilities/watchdog";
import { createBoard } from "../../../utilities/workspace-state-store";

// Core jobs (the issue import's sync) run for every workspace, not only pipeline ones, and wake notes only ride
// along with a wake that happens anyway.
describe("watchdog core jobs and wake notes", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("runs a core job on a landing-off workspace once per everyMin", async () => {
		const run = vi.fn(async () => "synced");
		const h = createWatchdogHarness({
			coreJobs: ({ workspaceId }) => (workspaceId === "ws-1" ? [{ name: "issues:sync", everyMin: 15, run }] : []),
		});
		cleanups.push(h.cleanup);
		h.observe({ workspaceId: "ws-1", board: createBoard({}) });
		await h.watchdog.tick();
		h.setNow(WATCHDOG_NOW + 5 * 60_000);
		await h.watchdog.tick();
		expect(run).toHaveBeenCalledTimes(1);
		h.setNow(WATCHDOG_NOW + 16 * 60_000);
		await h.watchdog.tick();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("only logs a due core job while the watchdog is in report", async () => {
		const run = vi.fn(async () => "synced");
		const h = createWatchdogHarness({
			config: { watchdog: { mode: "report" } },
			coreJobs: () => [{ name: "issues:sync", everyMin: 15, run }],
		});
		cleanups.push(h.cleanup);
		h.observe({ workspaceId: "ws-1", board: createBoard({}) });
		await h.watchdog.tick();
		expect(run).not.toHaveBeenCalled();
	});

	it("adds the wake notes to a wake, and takes none when nothing wakes the orchestrator", async () => {
		const takeWakeNotes = vi.fn(async () => ["- issue #2 (card b, In Progress) 1 new comment(s) upstream"]);
		const h = createWatchdogHarness({ takeWakeNotes });
		cleanups.push(h.cleanup);
		h.observe({ workspaceId: "ws-1", board: createBoard({}) });
		await h.watchdog.tick();
		expect(takeWakeNotes).not.toHaveBeenCalled();

		await addWakeRequest(h.paths("ws-1").wakeRequests, {
			issue: "1 new issue card(s) from vombor/kanban",
			when: null,
		});
		await h.watchdog.tick();
		expect(takeWakeNotes).toHaveBeenCalledTimes(1);
		expect(h.startHeadlessRun).toHaveBeenCalledTimes(1);
		const queue = readFileSync(h.paths("ws-1").orchestratorQueue, "utf8");
		expect(queue).toContain("1 new issue card(s) from vombor/kanban");
		expect(queue).toContain("issue #2 (card b, In Progress)");
	});
});
