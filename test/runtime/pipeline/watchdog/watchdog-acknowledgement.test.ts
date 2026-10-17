import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPipelineStateStore } from "../../../../src/pipeline/pipeline-state";
import { createPipelineControlApi } from "../../../../src/server/pipeline-control";
import { createWatchdogHarness, WATCHDOG_NOW } from "../../../utilities/watchdog";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

describe("acknowledged escalation notices (#60)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});
	it("keeps acknowledged holds out of human-decision wakes, reawakens on changed QA evidence, and clears stale Done notices", async () => {
		const harness = createWatchdogHarness({
			config: {
				watchdog: { mode: "on" },
				orchestrator: { wake: { mode: "sidebar", presentation: "full" } },
				workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team", preset: "cloud" } } },
			},
		});
		cleanups.push(harness.cleanup);
		const store = createPipelineStateStore({
			getStatePath: (id) => join(harness.home, "data", id, "pipeline-state.json"),
			getLegacyChecksStatePaths: () => [],
		});
		const dev = createCard({ id: "d1111", title: "BLOCKED: preserve review", updatedAt: WATCHDOG_NOW - 60_000 });
		const prereq = createCard({ id: "d2222", role: "triage" });
		let board = createBoard({ backlog: [dev], review: [prereq] });
		await store.update("foo", (state) => ({
			...state,
			cards: {
				d1111: {
					snapshot: "snap",
					qaflow: {
						escalated: {
							at: "2026-10-07T11:00:00Z",
							reason: "independent tooling prerequisite",
							cause: "qa_agent_error",
						},
					},
				},
				d2222: { snapshot: "baseline" },
			},
		}));
		const api = createPipelineControlApi({
			store,
			readBoard: async () => board,
			isLive: () => false,
			wake: () => {},
			now: () => WATCHDOG_NOW,
		});
		expect(
			await api.request({ kind: "user" }, "foo", {
				kind: "acknowledge",
				taskId: dev.id,
				reason: "Await independently audited setup",
				disposition: "held",
				waitForTaskId: prereq.id,
			}),
		).toMatchObject({ ok: true });
		harness.observe({ workspaceId: "foo", board });
		await harness.watchdog.tick();
		expect(
			harness.requests.some(
				(request) => request.kind === "startOrchestratorSession" || request.kind === "deliverInput",
			),
		).toBe(false);
		const text = readFileSync(harness.paths("foo").attention, "utf8");
		expect(text).toContain("Acknowledged orchestration holds");
		expect(text).not.toContain("Needs a human decision");
		harness.setNow(WATCHDOG_NOW + 31 * 60_000);
		await harness.watchdog.tick();
		expect(harness.requests.some((request) => request.kind === "startOrchestratorSession")).toBe(false);
		await store.update("foo", (state) => ({
			...state,
			cards: {
				...state.cards,
				d2222: { ...state.cards.d2222, qaVerdicts: [{ verdict: "STALLED", at: WATCHDOG_NOW + 31 * 60_000 }] },
			},
		}));
		await harness.watchdog.tick();
		expect(harness.requests.filter((request) => request.kind === "startOrchestratorSession")).toHaveLength(1);
		board = createBoard({ trash: [dev], review: [prereq] });
		harness.observe({ workspaceId: "foo", board });
		harness.requests.length = 0;
		await harness.watchdog.tick();
		expect(harness.requests.some((request) => request.kind === "startOrchestratorSession")).toBe(false);
		const remaining = existsSync(harness.paths("foo").attention)
			? readFileSync(harness.paths("foo").attention, "utf8")
			: "";
		expect(remaining).not.toContain("d1111");
	});
});
