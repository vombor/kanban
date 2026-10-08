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

	it("each workspace's issue job, its wake and its notes stay with that workspace's own orchestrator", async () => {
		const ran: string[] = [];
		const takeWakeNotes = vi.fn(async (workspaceId: string) => [`- ${workspaceId}: issue #2 has new comments`]);
		const h = createWatchdogHarness({
			config: {
				watchdog: { mode: "on" },
				orchestrator: { wake: { mode: "sidebar" } },
				workspaces: { quiet: { orchestrator: { wake: { enabled: false } } } },
			},
			coreJobs: ({ workspaceId }) => [
				{
					name: "issues:sync",
					everyMin: 15,
					run: async () => {
						ran.push(workspaceId);
						return "synced";
					},
				},
			],
			takeWakeNotes,
		});
		cleanups.push(h.cleanup);
		h.observe({ workspaceId: "ws-1", board: createBoard({}) });
		h.observe({ workspaceId: "ws-2", board: createBoard({}) });
		h.observe({ workspaceId: "quiet", board: createBoard({}) });
		for (const workspaceId of ["ws-1", "quiet"]) {
			await addWakeRequest(h.paths(workspaceId).wakeRequests, {
				issue: `1 new issue card(s) from vombor/${workspaceId}`,
				when: null,
			});
		}
		await h.watchdog.tick();
		expect(ran.sort()).toEqual(["quiet", "ws-1", "ws-2"]);
		const wakes = h.requests.filter(
			(request) => request.kind === "startOrchestratorSession" || request.kind === "deliverInput",
		);
		expect(wakes).toEqual([
			expect.objectContaining({ kind: "startOrchestratorSession", workspaceId: "ws-1", fromWorkspaceId: "ws-1" }),
		]);
		const prompt = wakes[0] && "prompt" in wakes[0] ? wakes[0].prompt : "";
		expect(prompt).toContain("1 new issue card(s) from vombor/ws-1");
		expect(prompt).toContain("ws-1: issue #2 has new comments");
		expect(prompt).not.toContain("quiet");
		// Wakes off: the wake waits in quiet's own ATTENTION.md, and its notes stay in its issue state.
		expect(readFileSync(h.paths("quiet").attention, "utf8")).toContain(
			"- **wake request** (now): 1 new issue card(s) from vombor/quiet",
		);
		expect(takeWakeNotes.mock.calls).toEqual([["ws-1"]]);
	});
});
