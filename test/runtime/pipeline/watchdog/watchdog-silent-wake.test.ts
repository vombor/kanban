import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeAgentId } from "../../../../src/core/api-contract";
import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import { decideWakeDelivery } from "../../../../src/pipeline/watchdog/wake";
import { addWakeRequest } from "../../../../src/pipeline/watchdog/wake-requests";
import { createWatchdogHarness, WATCHDOG_NOW } from "../../../utilities/watchdog";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

const MIN = 60_000;
const harnesses: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function harnessWith(config: unknown, options: Parameters<typeof createWatchdogHarness>[0] = {}) {
	const harness = createWatchdogHarness({ ...options, config });
	harnesses.push(harness);
	return harness;
}

function sidebar(
	workspaceId: string,
	typedMinAgo: number | null,
	agentId: RuntimeAgentId = "claude",
): PipelineSessionView {
	return {
		taskId: `__home_agent__:${workspaceId}:${agentId}`,
		agentId,
		modelId: null,
		state: "awaiting_review",
		pid: 9,
		viewerTypedAt: typedMinAgo === null ? null : WATCHDOG_NOW - typedMinAgo * MIN,
	};
}

// A Claude card stuck on a startup dialog: an item that needs the user.
function stuckOnPrompt(taskId: string): PipelineSessionView {
	return {
		taskId,
		agentId: "claude",
		modelId: null,
		state: "running",
		startedAt: WATCHDOG_NOW - 10 * MIN,
		lastHookAt: null,
		workspacePath: `/wt/${taskId}`,
		pid: 10,
	};
}

async function wakeWith(
	config: unknown,
	input: { sessions: PipelineSessionView[]; urgent?: boolean; selectedAgentId?: RuntimeAgentId },
	options: Parameters<typeof createWatchdogHarness>[0] = {},
) {
	const harness = harnessWith(config, options);
	await addWakeRequest(harness.paths("plain").wakeRequests, {
		issue: "look at the plan",
		when: null,
		now: new Date(WATCHDOG_NOW),
	});
	harness.observe({
		workspaceId: "plain",
		board: createBoard({
			in_progress: input.urgent ? [createCard({ id: "d0003", updatedAt: WATCHDOG_NOW - 60 * MIN })] : [],
		}),
		sessions: [...input.sessions, ...(input.urgent ? [stuckOnPrompt("d0003")] : [])],
		...(input.selectedAgentId ? { selectedAgentId: input.selectedAgentId } : {}),
	});
	await harness.watchdog.tick();
	return harness;
}

const SIDEBAR_CONFIG = { watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } };

function kinds(harness: ReturnType<typeof createWatchdogHarness>): string[] {
	return harness.requests.map((request) => request.kind);
}

describe("silent wakes (orchestrator.wake.delivery)", () => {
	it("auto: queues the wake silently while the user works in the sidebar, typed quietMin later if unread", async () => {
		const harness = await wakeWith(SIDEBAR_CONFIG, { sessions: [sidebar("plain", 5)] });
		expect(kinds(harness)).toEqual(["queueOrchestratorNotices"]);
		const request = harness.requests[0];
		expect(request).toMatchObject({
			kind: "queueOrchestratorNotices",
			workspaceId: "plain",
			fromWorkspaceId: "plain",
			taskId: "__home_agent__:plain:claude",
			typeAfter: WATCHDOG_NOW + 30 * MIN,
		});
		expect(request && "text" in request ? request.text : "").toContain("look at the plan");
		const decisions = readFileSync(harness.paths("plain").decisions, "utf8");
		expect(decisions).toContain("sidebar-silent: queued silently");
		// Marked woken: the next tick doesn't queue or type it again.
		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + MIN);
		await harness.watchdog.tick();
		expect(kinds(harness)).not.toContain("deliverInput");
	});

	it("auto: types the wake when the user hasn't typed in the sidebar within quietMin", async () => {
		const away = await wakeWith(SIDEBAR_CONFIG, { sessions: [sidebar("plain", 31)] });
		expect(kinds(away)).toEqual(["deliverInput"]);
		const never = await wakeWith(SIDEBAR_CONFIG, { sessions: [sidebar("plain", null)] });
		expect(kinds(never)).toEqual(["deliverInput"]);
		// A workspace's own quietMin.
		const longer = await wakeWith(
			{ ...SIDEBAR_CONFIG, workspaces: { plain: { orchestrator: { wake: { quietMin: 60 } } } } },
			{ sessions: [sidebar("plain", 31)] },
		);
		expect(longer.requests[0]).toMatchObject({
			kind: "queueOrchestratorNotices",
			typeAfter: WATCHDOG_NOW + 60 * MIN,
		});
	});

	it("auto: types an urgent item at once, even while the user works in the sidebar", async () => {
		const harness = await wakeWith(SIDEBAR_CONFIG, { sessions: [sidebar("plain", 1)], urgent: true });
		expect(kinds(harness)).toEqual(["deliverInput"]);
		const request = harness.requests[0];
		expect(request && "text" in request ? request.text : "").toContain("d0003");
		expect(readFileSync(harness.paths("plain").decisions, "utf8")).toContain("needs the user or an answer now");
	});

	it("type never queues; silent queues urgent items too; the workspace override wins", async () => {
		const typed = await wakeWith(
			{ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar", delivery: "type" } } },
			{ sessions: [sidebar("plain", 1)] },
		);
		expect(kinds(typed)).toEqual(["deliverInput"]);
		const silent = await wakeWith(
			{
				...SIDEBAR_CONFIG,
				workspaces: { plain: { orchestrator: { wake: { delivery: "silent" } } } },
			},
			{ sessions: [sidebar("plain", null)], urgent: true },
		);
		expect(kinds(silent)).toEqual(["queueOrchestratorNotices"]);
	});

	it("falls back to typing when the silent queue fails", async () => {
		const harness = await wakeWith(
			SIDEBAR_CONFIG,
			{ sessions: [sidebar("plain", 1)] },
			{ results: { queueOrchestratorNotices: { ok: false, pending: 0, error: "disk full" } } },
		);
		expect(kinds(harness)).toEqual(["queueOrchestratorNotices", "deliverInput"]);
		expect(readFileSync(harness.paths("plain").decisions, "utf8")).toContain("the silent queue failed (disk full)");
	});

	it("an agent without the prompt hook keeps typing", async () => {
		const harness = await wakeWith(SIDEBAR_CONFIG, {
			sessions: [sidebar("plain", 1, "codex")],
			selectedAgentId: "codex",
		});
		expect(kinds(harness)).toEqual(["deliverInput"]);
	});

	it("only a live sidebar is queued for: no sidebar starts one, a headless run keeps its queue", async () => {
		const started = await wakeWith(SIDEBAR_CONFIG, { sessions: [] });
		expect(kinds(started)).toEqual(["startOrchestratorSession"]);
		const headless = await wakeWith(
			{ watchdog: { mode: "on" } },
			{ sessions: [sidebar("plain", 1)] },
			{ headlessPid: 4321 },
		);
		expect(kinds(headless)).toEqual([]);
		expect(existsSync(headless.paths("plain").orchestratorQueue)).toBe(true);
	});
});

describe("decideWakeDelivery", () => {
	const base = {
		policy: "auto" as const,
		agentTakesSilentNotices: true,
		userTypedAt: WATCHDOG_NOW - MIN,
		now: WATCHDOG_NOW,
		quietMs: 30 * MIN,
		urgent: false,
	};
	it("decides by policy, agent, urgency and the user's last keystroke", () => {
		expect(decideWakeDelivery(base).silent).toBe(true);
		expect(decideWakeDelivery({ ...base, agentTakesSilentNotices: false, policy: "silent" }).silent).toBe(false);
		expect(decideWakeDelivery({ ...base, policy: "type" }).silent).toBe(false);
		expect(decideWakeDelivery({ ...base, urgent: true }).silent).toBe(false);
		expect(decideWakeDelivery({ ...base, policy: "silent", urgent: true }).silent).toBe(true);
		expect(decideWakeDelivery({ ...base, userTypedAt: WATCHDOG_NOW - 30 * MIN }).silent).toBe(false);
		expect(decideWakeDelivery({ ...base, userTypedAt: null }).silent).toBe(false);
	});
});
