// The orchestrator wake (plan §9): the target is createHomeAgentSessionId(ws, selectedAgentId) whatever the selected
// agent is; headless falls back to the sidebar when the agent has no headless runner; never two orchestrators (a live
// sidebar or a running headless run blocks a second) and never zero (no live sidebar → one is started server-side); and only ever the orchestrator of the workspace the
// items are about.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeAgentId } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import type { PipelineSessionView } from "../../../src/pipeline/engine";
import { wakeOrchestrator } from "../../../src/pipeline/watchdog/wake";
import { addWakeRequest } from "../../../src/pipeline/watchdog/wake-requests";
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
		workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } } },
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

// Project isolation: a workspace's items wake only its own orchestrator; there is no cross-workspace wake target.
describe("watchdog wake isolated by project", () => {
	const TWO_QA = {
		foo: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } },
		bar: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } },
	};

	function barBoard() {
		return createBoard({
			review: [createCard({ id: "e0001", updatedAt: WATCHDOG_NOW - 60 * MIN, createdAt: WATCHDOG_NOW - 90 * MIN })],
		});
	}

	function twoProjects(config: Record<string, unknown>, options: Parameters<typeof createWatchdogHarness>[0] = {}) {
		const harness = createWatchdogHarness({ ...options, config });
		harnesses.push(harness);
		harness.observe({
			workspaceId: "foo",
			board: stalledBoard(),
			selectedAgentId: "claude",
			sessions: [liveSidebar("foo", "claude")],
		});
		harness.observe({ workspaceId: "bar", board: barBoard(), selectedAgentId: "codex" });
		return harness;
	}

	function wakeRequests(harness: ReturnType<typeof createWatchdogHarness>) {
		return harness.requests.filter(
			(request) => request.kind === "deliverInput" || request.kind === "startOrchestratorSession",
		);
	}

	function textOf(request: { kind: string } | undefined): string {
		return request && "text" in request
			? String(request.text)
			: request && "prompt" in request
				? String(request.prompt)
				: "";
	}

	it("two workspaces, one stall each: each wake reaches only its own orchestrator, the old target key ignored", async () => {
		// `target` is the removed machine-wide key (foo's stalls once went to kanban-2uge's sidebar, 10/07).
		const harness = twoProjects({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar", target: "foo" } },
			workspaces: TWO_QA,
		});
		await harness.watchdog.tick();
		const wakes = wakeRequests(harness);
		expect(wakes).toEqual([
			expect.objectContaining({
				kind: "deliverInput",
				workspaceId: "foo",
				taskId: createHomeAgentSessionId("foo", "claude"),
				fromWorkspaceId: "foo",
			}),
			expect.objectContaining({
				kind: "startOrchestratorSession",
				workspaceId: "bar",
				agentId: "codex",
				fromWorkspaceId: "bar",
			}),
		]);
		expect(textOf(wakes[0])).toContain("d0001");
		expect(textOf(wakes[0])).not.toContain("e0001");
		expect(textOf(wakes[1])).toContain("workspace bar (/projects/bar)");
		expect(textOf(wakes[1])).toContain("e0001");
		expect(textOf(wakes[1])).not.toContain("d0001");
	});

	it("headless: each workspace's run and queue are its own", async () => {
		const harness = twoProjects({ watchdog: { mode: "on" }, workspaces: TWO_QA });
		harness.observe({ workspaceId: "foo", board: stalledBoard(), selectedAgentId: "claude" });
		await harness.watchdog.tick();
		expect(harness.startHeadlessRun.mock.calls.map(([input]) => input.workspaceId)).toEqual(["foo", "bar"]);
		expect(readFileSync(harness.paths("foo").orchestratorQueue, "utf8")).not.toContain("e0001");
		expect(readFileSync(harness.paths("bar").orchestratorQueue, "utf8")).toMatch(/\[bar\] e0001:/);
		expect(readFileSync(harness.paths("bar").orchestratorQueue, "utf8")).not.toContain("d0001");
	});

	it("a workspace whose wakes are off gets its items in its own ATTENTION.md only; the other is still woken", async () => {
		const harness = twoProjects({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: { ...TWO_QA, bar: { ...TWO_QA.bar, orchestrator: { wake: { enabled: false } } } },
		});
		await addWakeRequest(harness.paths("bar").wakeRequests, {
			issue: "look at the plan",
			when: null,
			now: new Date(WATCHDOG_NOW),
		});
		await harness.watchdog.tick();
		expect(wakeRequests(harness)).toEqual([
			expect.objectContaining({ kind: "deliverInput", workspaceId: "foo", fromWorkspaceId: "foo" }),
		]);
		expect(textOf(wakeRequests(harness)[0])).not.toContain("e0001");
		const attention = readFileSync(harness.paths("bar").attention, "utf8");
		expect(attention).toContain("- **e0001** (stall): dev card has been in Review");
		expect(attention).toContain("- **wake request** (now): look at the plan");
		// The request waits for a wake instead of being used up.
		expect(JSON.parse(readFileSync(harness.paths("bar").wakeRequests, "utf8")).requests).toHaveLength(1);
		expect(readFileSync(harness.paths("bar").decisions, "utf8")).toContain(
			"workspaces.bar.orchestrator.wake.enabled is off",
		);

		// Still listed on the next tick (no triage cooldown for ATTENTION), still nobody woken for it.
		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + MIN);
		await harness.watchdog.tick();
		expect(readFileSync(harness.paths("bar").attention, "utf8")).toContain("- **e0001** (stall)");
		expect(wakeRequests(harness).filter((request) => request.workspaceId === "bar")).toEqual([]);
	});

	it("wake state is per workspace: foo's pending Enter neither blocks nor retargets bar's wake", async () => {
		const harness = twoProjects(
			{ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } }, workspaces: TWO_QA },
			{
				respond: (request) =>
					request.kind === "deliverInput" && request.workspaceId === "foo"
						? deliveryResult("undelivered")
						: undefined,
			},
		);
		harness.observe({
			workspaceId: "bar",
			board: barBoard(),
			selectedAgentId: "codex",
			sessions: [liveSidebar("bar", "codex")],
		});
		await harness.watchdog.tick();
		const fooState = JSON.parse(readFileSync(harness.paths("foo").state, "utf8"));
		const barState = JSON.parse(readFileSync(harness.paths("bar").state, "utf8"));
		expect(fooState.wakeEnter).toMatchObject({ taskId: createHomeAgentSessionId("foo", "claude") });
		expect(barState.wakeEnter).toBeNull();
		expect(Object.keys(barState.woken).some((key) => key.includes("e0001"))).toBe(true);
		expect(Object.keys(fooState.woken)).toEqual([]);

		// bar gets a new item next tick and is typed into normally; foo only gets its Enter.
		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + MIN);
		await addWakeRequest(harness.paths("bar").wakeRequests, {
			issue: "next step",
			when: null,
			now: new Date(WATCHDOG_NOW),
		});
		await harness.watchdog.tick();
		expect(wakeRequests(harness)).toEqual([
			expect.objectContaining({ workspaceId: "foo", taskId: createHomeAgentSessionId("foo", "claude"), text: "" }),
			expect.objectContaining({ workspaceId: "bar", taskId: createHomeAgentSessionId("bar", "codex") }),
		]);
		expect(textOf(wakeRequests(harness)[1])).toContain("next step");
	});

	it.each(["report", "enforce"] as const)(
		"isolation %s: every wake request names its own workspace as the target and the sender",
		async (mode) => {
			const harness = twoProjects({
				watchdog: { mode: "on" },
				orchestrator: { wake: { mode: "sidebar", target: "foo" } },
				isolation: { mode },
				workspaces: TWO_QA,
			});
			await harness.watchdog.tick();
			const wakes = wakeRequests(harness);
			expect(wakes.map((request) => request.workspaceId)).toEqual(["foo", "bar"]);
			for (const request of wakes) {
				expect("fromWorkspaceId" in request && request.fromWorkspaceId).toBe(request.workspaceId);
			}
		},
	);

	it("a headless run gets its workspace's session credential, bound to the run's pid", async () => {
		const harness = createWatchdogHarness({
			config: qaConfig({ mode: "headless" }, { isolation: { mode: "report" } }),
		});
		harnesses.push(harness);
		harness.observe({ workspaceId: "foo", board: stalledBoard(), selectedAgentId: "claude" });
		await harness.watchdog.tick();
		expect(harness.requests).toContainEqual({
			kind: "issueOrchestratorCredential",
			workspaceId: "foo",
			agentId: "claude",
		});
		expect(harness.startHeadlessRun).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "foo",
				env: { KANBAN_SESSION_CREDENTIAL: "cred-headless", KANBAN_SESSION_WORKSPACE_ID: "foo" },
			}),
		);
		expect(harness.requests).toContainEqual({
			kind: "bindOrchestratorCredential",
			credential: "cred-headless",
			pid: 4242,
		});
	});

	it("enforce: a headless wake goes to the sidebar session (a headless run has no isolation guardrails)", async () => {
		const harness = createWatchdogHarness({
			config: qaConfig({ mode: "headless" }, { isolation: { mode: "enforce" } }),
		});
		harnesses.push(harness);
		harness.observe({ workspaceId: "foo", board: stalledBoard(), selectedAgentId: "claude" });
		await harness.watchdog.tick();
		expect(harness.startHeadlessRun).not.toHaveBeenCalled();
		expect(harness.requests.filter((request) => request.kind === "startOrchestratorSession")).toEqual([
			expect.objectContaining({ workspaceId: "foo", agentId: "claude" }),
		]);
	});
});
