// The orchestrator wake (plan §9): the target is createHomeAgentSessionId(ws, selectedAgentId) whatever the selected
// agent is; headless falls back to the sidebar when the agent has no headless runner; never two orchestrators (a live
// sidebar or a running headless run blocks a second) and never zero (no live sidebar → one is started server-side).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeAgentId } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import type { PipelineSessionView } from "../../../src/pipeline/engine";
import { wakeOrchestrator } from "../../../src/pipeline/watchdog/wake";
import { createEmptyWatchdogState } from "../../../src/pipeline/watchdog/watchdog-state";
import { createWatchdogHarness, deliveryResult, WATCHDOG_NOW } from "../../utilities/watchdog";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const MIN = 60_000;
const harnesses: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

// A Review dev card with work stalled for an hour on a `qa` workspace of the team kit: one wake item.
function stalledBoard() {
	return createBoard({
		review: [createCard({ id: "d0001", updatedAt: WATCHDOG_NOW - 60 * MIN, createdAt: WATCHDOG_NOW - 90 * MIN })],
	});
}

function qaConfig(wake: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	return {
		watchdog: { mode: "on" },
		orchestrator: { wake },
		workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" } } },
		...extra,
	};
}

function liveSidebar(workspaceId: string, agentId: RuntimeAgentId): PipelineSessionView {
	return {
		taskId: createHomeAgentSessionId(workspaceId, agentId),
		agentId,
		modelId: null,
		state: "awaiting_review",
		pid: 4242,
	};
}

describe("watchdog wake target", () => {
	it.each(["claude", "codex", "cline"] as const)(
		"wakes the selected agent %s in its sidebar session",
		async (agentId) => {
			const harness = createWatchdogHarness({ config: qaConfig({ mode: "sidebar" }) });
			harnesses.push(harness);
			harness.observe({ workspaceId: "foo", board: stalledBoard(), selectedAgentId: agentId });
			await harness.watchdog.tick();
			const start = harness.requests.find((request) => request.kind === "startOrchestratorSession");
			expect(start).toMatchObject({ kind: "startOrchestratorSession", workspaceId: "foo", agentId });
			expect(start && "prompt" in start ? start.prompt : "").toContain("d0001");
			expect(harness.startHeadlessRun).not.toHaveBeenCalled();
			expect(harness.log).toHaveBeenCalledWith(expect.stringContaining(createHomeAgentSessionId("foo", agentId)));
		},
	);

	it("headless mode runs the agent headless only when it has a runner, else starts its sidebar", async () => {
		for (const [agentId, expectHeadless] of [
			["claude", true],
			["codex", true],
			["cline", false],
			["copilot", false],
		] as const) {
			const harness = createWatchdogHarness({ config: qaConfig({ mode: "headless" }) });
			harnesses.push(harness);
			harness.observe({ workspaceId: "foo", board: stalledBoard(), selectedAgentId: agentId });
			await harness.watchdog.tick();
			const started = harness.requests.filter((request) => request.kind === "startOrchestratorSession");
			if (expectHeadless) {
				expect(harness.startHeadlessRun).toHaveBeenCalledWith(
					expect.objectContaining({ workspaceId: "foo", agentId }),
				);
				expect(started).toEqual([]);
				expect(readFileSync(harness.paths("foo").orchestratorQueue, "utf8")).toMatch(
					/\[foo\] d0001: dev card has been in Review/,
				);
			} else {
				expect(harness.startHeadlessRun).not.toHaveBeenCalled();
				expect(started).toEqual([expect.objectContaining({ agentId, workspaceId: "foo" })]);
			}
		}
	});

	it("types into a live sidebar and never starts a headless run beside it", async () => {
		const harness = createWatchdogHarness({ config: qaConfig({ mode: "headless" }) });
		harnesses.push(harness);
		harness.observe({ workspaceId: "foo", board: stalledBoard(), sessions: [liveSidebar("foo", "claude")] });
		await harness.watchdog.tick();
		expect(harness.startHeadlessRun).not.toHaveBeenCalled();
		expect(harness.requests.filter((request) => request.kind === "deliverInput")).toEqual([
			expect.objectContaining({ workspaceId: "foo", taskId: createHomeAgentSessionId("foo", "claude") }),
		]);
	});

	it("queues for a running headless run instead of typing or starting anything", async () => {
		const harness = createWatchdogHarness({ config: qaConfig({ mode: "sidebar" }), headlessPid: 999 });
		harnesses.push(harness);
		harness.observe({ workspaceId: "foo", board: stalledBoard(), sessions: [liveSidebar("foo", "claude")] });
		await harness.watchdog.tick();
		expect(harness.requests.map((request) => request.kind)).not.toContain("deliverInput");
		expect(harness.requests.map((request) => request.kind)).not.toContain("startOrchestratorSession");
		expect(harness.startHeadlessRun).not.toHaveBeenCalled();
		expect(readFileSync(harness.paths("foo").orchestratorQueue, "utf8")).toContain("[foo] d0001:");
	});

	it("routes every workspace's wake to orchestrator.wake.target's sidebar, on that workspace's selected agent", async () => {
		const harness = createWatchdogHarness({ config: qaConfig({ mode: "sidebar", target: "home" }) });
		harnesses.push(harness);
		harness.observe({
			workspaceId: "home",
			board: createBoard({}),
			selectedAgentId: "codex",
			workspacePath: "/projects/home",
		});
		harness.observe({ workspaceId: "foo", board: stalledBoard(), selectedAgentId: "claude" });
		await harness.watchdog.tick();
		const start = harness.requests.find((request) => request.kind === "startOrchestratorSession");
		expect(start).toMatchObject({ workspaceId: "home", agentId: "codex" });
		expect(start && "prompt" in start ? start.prompt : "").toContain("workspace foo (/projects/foo)");
	});

	it("doesn't start a second session for the same wake target within one tick", async () => {
		const harness = createWatchdogHarness({
			config: {
				...qaConfig({ mode: "sidebar", target: "foo" }),
				workspaces: {
					foo: { landing: { mode: "qa" }, kit: { name: "team" } },
					bar: { landing: { mode: "qa" }, kit: { name: "team" } },
				},
			},
		});
		harnesses.push(harness);
		harness.observe({ workspaceId: "foo", board: stalledBoard() });
		harness.observe({
			workspaceId: "bar",
			board: createBoard({ review: [createCard({ id: "e0001", updatedAt: WATCHDOG_NOW - 60 * MIN })] }),
		});
		await harness.watchdog.tick();
		const kinds = harness.requests.map((request) => request.kind).filter((kind) => kind !== "pruneDone");
		expect(kinds).toEqual(["startOrchestratorSession", "deliverInput"]);
	});

	it("respects the cooldown: the same item doesn't wake again within cooldownMin", async () => {
		const harness = createWatchdogHarness({ config: qaConfig({ mode: "sidebar", cooldownMin: 30 }) });
		harnesses.push(harness);
		harness.observe({ workspaceId: "foo", board: stalledBoard(), sessions: [liveSidebar("foo", "claude")] });
		await harness.watchdog.tick();
		harness.setNow(WATCHDOG_NOW + 5 * MIN);
		await harness.watchdog.tick();
		expect(harness.requests.filter((request) => request.kind === "deliverInput")).toHaveLength(1);
	});

	it("wakes nobody with orchestrator.wake.enabled off", async () => {
		const harness = createWatchdogHarness({ config: qaConfig({ enabled: false }) });
		harnesses.push(harness);
		harness.observe({ workspaceId: "foo", board: stalledBoard() });
		await harness.watchdog.tick();
		expect(harness.requests.map((request) => request.kind)).toEqual(["pruneDone"]);
		expect(harness.startHeadlessRun).not.toHaveBeenCalled();
	});
});

describe("wakeOrchestrator", () => {
	const target = {
		workspaceId: "foo",
		projectPath: "/projects/foo",
		agentId: "claude" as const,
		sessionId: createHomeAgentSessionId("foo", "claude"),
		session: liveSidebar("foo", "claude"),
	};

	it("text typed but not taken gets only an Enter next time, never the text again", async () => {
		const state = createEmptyWatchdogState();
		const typed: string[] = [];
		const results = [deliveryResult("undelivered"), deliveryResult("delivered")];
		const deps = {
			headlessPid: () => 0,
			hasHeadlessRunner: true,
			queueForHeadless: async () => {},
			startHeadless: async () => ({ ok: true }),
			deliver: async (text: string) => {
				typed.push(text);
				return results.shift() ?? deliveryResult("delivered");
			},
			startSession: async () => ({ ok: true }),
		};
		const base = {
			state,
			queued: [],
			target,
			mode: "sidebar" as const,
			text: () => "WAKE",
			cooldownMs: 30 * MIN,
			retryMs: 120 * MIN,
			deps,
		};
		const first = await wakeOrchestrator({ ...base, items: ["- a: x"], now: WATCHDOG_NOW });
		expect(first).toMatchObject({ path: "retry", ok: false });
		expect(state.wakeEnter?.items).toEqual(["- a: x"]);
		const second = await wakeOrchestrator({ ...base, items: ["- a: x"], now: WATCHDOG_NOW + MIN });
		expect(second).toMatchObject({ path: "sidebar-enter", ok: true });
		expect(typed).toEqual(["WAKE", ""]);
		expect(state.wakeEnter).toBeNull();
		expect(Object.keys(state.woken)).toEqual(["- a: x"]);
	});

	it("a failed start keeps queued items for the next tick", async () => {
		const state = createEmptyWatchdogState();
		const outcome = await wakeOrchestrator({
			state,
			items: ["- q: queued"],
			queued: ["- q: queued"],
			target: { ...target, session: null },
			mode: "sidebar",
			text: () => "WAKE",
			now: WATCHDOG_NOW,
			cooldownMs: 30 * MIN,
			retryMs: 120 * MIN,
			deps: {
				headlessPid: () => 0,
				hasHeadlessRunner: false,
				queueForHeadless: async () => {},
				startHeadless: async () => ({ ok: true }),
				deliver: async () => deliveryResult("delivered"),
				startSession: async () => ({ ok: false, error: "no agent" }),
			},
		});
		expect(outcome).toMatchObject({ path: "retry", ok: false });
		expect(state.wakeRetry.map((entry) => entry.item)).toEqual(["- q: queued"]);
		expect(state.woken).toEqual({});
	});
});
