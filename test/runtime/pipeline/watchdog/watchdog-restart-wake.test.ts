// The "Kanban restarted" wake: once per server start each workspace's own orchestrator hears when Kanban started,
// whether the previous stop was clean, and what restart recovery did there (restart-wake.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../../src/core/api-contract";
import type { PipelineDecisionRecord } from "../../../../src/pipeline/decision-log";
import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import type { RestartManifest } from "../../../../src/pipeline/restart-recovery";
import type { WatchdogActionRequest } from "../../../../src/pipeline/watchdog/actions";
import {
	describePreviousStop,
	RESTART_WAKE_ITEM_MARKER,
	summarizeRestartRecords,
} from "../../../../src/pipeline/watchdog/restart-wake";
import { createTypedInputHold } from "../../../../src/server/typed-input-hold";
import { createWatchdogActionHandler } from "../../../../src/server/watchdog-actions";
import { getPipelineDecisionLogPath, getRestartManifestPath } from "../../../../src/state/kanban-home";
import { TerminalSessionManager, VIEWER_TYPING_QUIET_MS } from "../../../../src/terminal/session-manager";
import { createWatchdogHarness, type RestartPassView, WATCHDOG_NOW } from "../../../utilities/watchdog";
import { createBoard } from "../../../utilities/workspace-state-store";

const MIN = 60_000;
const SERVER_STARTED_AT = WATCHDOG_NOW - 30_000;
const PREVIOUS_SERVER_STARTED_AT = WATCHDOG_NOW - 86_400_000;
const QA_FOO = { foo: { landing: { mode: "qa" }, kit: { name: "team" } } };
const SIDEBAR_CONFIG = { watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } }, workspaces: QA_FOO };

const harnesses: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	vi.useRealTimers();
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function harnessWith(config: unknown, options: Parameters<typeof createWatchdogHarness>[0] = {}) {
	const harness = createWatchdogHarness({ ...options, config });
	harnesses.push(harness);
	return harness;
}

/** The workspace's sidebar from before the restart: its process died with the old server, its pid stays. */
function sidebarBeforeRestart(workspaceId: string): PipelineSessionView {
	return {
		taskId: `__home_agent__:${workspaceId}:claude`,
		agentId: "claude",
		modelId: null,
		state: "awaiting_review",
		pid: 77,
		startedAt: WATCHDOG_NOW - 120 * MIN,
		live: false,
	};
}

function writeShutdownManifest(home: string, workspaceId: string): void {
	const manifest: RestartManifest = {
		at: new Date(WATCHDOG_NOW - 60_000).toISOString(),
		kanbanStart: new Date(PREVIOUS_SERVER_STARTED_AT).toISOString(),
		source: "shutdown",
		cards: [],
	};
	const path = getRestartManifestPath(workspaceId, home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(manifest));
}

function restartRecord(
	taskId: string | null,
	answerKind: string | null,
	outcome: PipelineDecisionRecord["outcome"],
	note: string,
	at = WATCHDOG_NOW - 20_000,
): PipelineDecisionRecord {
	return {
		at: new Date(at).toISOString(),
		workspaceId: "foo",
		taskId,
		stage: "restart",
		kit: "team",
		landingMode: "qa",
		shadow: false,
		effectiveAgent: null,
		model: null,
		role: null,
		answer: answerKind ? { kind: answerKind } : null,
		outcome,
		note,
	};
}

/** What restart recovery wrote for foo: d0001 resumed, d0002 held for capacity, QA card q0001 handed to the gate. */
function writeFooRestartRecords(home: string): void {
	const records = [
		restartRecord(
			"d9999",
			"resume",
			"acted",
			"resumed on old (a restart before this one)",
			PREVIOUS_SERVER_STARTED_AT,
		),
		restartRecord(null, null, "none", "Kanban started 2026-10-07T11:59:30.000Z: 3 orphaned card(s)"),
		restartRecord("d0001", "resume", "acted", "orphaned (in_progress): session running; resuming on the same model"),
		restartRecord("d0002", "resume", "acted", "orphaned (review): session running; resuming on the same model"),
		restartRecord("q0001", "recreate_qa", "acted", "orphaned QA card (review): handed to the QA gate"),
		restartRecord("d0001", "resume", "acted", "resumed on claude-sonnet (no WIP tag, conversation continued)"),
		restartRecord(
			"d0002",
			"resume",
			"failed",
			"not resumed: lemonade holds 1 model; by hand: kanban task resume d0002",
		),
	];
	const path = getPipelineDecisionLogPath("foo", home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function fooPass(overrides: Partial<RestartPassView> = {}): RestartPassView {
	return {
		serverStartedAt: SERVER_STARTED_AT,
		manifest: {
			at: new Date(WATCHDOG_NOW - 60_000).toISOString(),
			kanbanStart: new Date(PREVIOUS_SERVER_STARTED_AT).toISOString(),
			source: "shutdown",
			cards: [],
		},
		manifestUsed: true,
		orphans: 3,
		resuming: false,
		...overrides,
	};
}

function observeRestarted(
	harness: ReturnType<typeof harnessWith>,
	workspaceId: string,
	sessions: PipelineSessionView[] = [sidebarBeforeRestart(workspaceId)],
): void {
	harness.observe({
		workspaceId,
		board: createBoard({}),
		sessions,
		serverStartedAt: SERVER_STARTED_AT,
		previousServerStartedAt: PREVIOUS_SERVER_STARTED_AT,
	});
}

function restartWakes(requests: WatchdogActionRequest[]): WatchdogActionRequest[] {
	return requests.filter(
		(request) =>
			(request.kind === "startOrchestratorSession" && request.prompt.includes(RESTART_WAKE_ITEM_MARKER)) ||
			(request.kind === "deliverInput" && request.text.includes(RESTART_WAKE_ITEM_MARKER)),
	);
}

function textOf(request: WatchdogActionRequest | undefined): string {
	if (request?.kind === "startOrchestratorSession") {
		return request.prompt;
	}
	return request?.kind === "deliverInput" ? request.text : "";
}

describe("restart wake", () => {
	it("wakes each workspace's own orchestrator once, with its own facts and none of another's", async () => {
		let pass: RestartPassView | null = null;
		const harness = harnessWith(SIDEBAR_CONFIG, {
			readRestartPass: (workspaceId) => (workspaceId === "foo" ? pass : null),
		});
		writeShutdownManifest(harness.home, "foo");
		writeFooRestartRecords(harness.home);
		observeRestarted(harness, "foo");
		observeRestarted(harness, "bar");

		// foo's restart recovery hasn't run yet (within the grace): only bar, where recovery doesn't run, is woken.
		await harness.watchdog.tick();
		expect(
			restartWakes(harness.requests).map(
				(request) => request.kind === "startOrchestratorSession" && request.workspaceId,
			),
		).toEqual(["bar"]);

		pass = fooPass();
		harness.setNow(WATCHDOG_NOW + 10_000);
		await harness.watchdog.tick();
		const wakes = restartWakes(harness.requests);
		expect(wakes).toHaveLength(2);
		const foo = wakes.find((request) => request.kind === "startOrchestratorSession" && request.workspaceId === "foo");
		const bar = wakes.find((request) => request.kind === "startOrchestratorSession" && request.workspaceId === "bar");
		// Identity: each names its own workspace, and continues the conversation the restart cut off (Claude).
		expect(foo).toMatchObject({ fromWorkspaceId: "foo", agentId: "claude", continueConversation: true });
		expect(bar).toMatchObject({ fromWorkspaceId: "bar", agentId: "claude", continueConversation: true });

		const fooText = textOf(foo);
		expect(fooText).toContain("Kanban restarted at 2026-10-07 11:59:30Z");
		expect(fooText).toContain("the previous server stopped cleanly (shutdown at 2026-10-07 11:59:00Z)");
		expect(fooText).toContain("3 card(s) lost their agent; resumed d0001");
		expect(fooText).toContain("NOT resumed: d0002 (not resumed: lemonade holds 1 model");
		expect(fooText).toContain("dead QA card(s) q0001 handed to the QA gate");
		expect(fooText).toContain("this session continues your conversation from before the restart");
		expect(fooText).toContain("tell the user what the restart did");
		expect(fooText).not.toContain("d9999");
		expect(fooText).not.toContain("bar");

		const barText = textOf(bar);
		expect(barText).toContain("the previous server did not stop cleanly (no shutdown record)");
		expect(barText).toContain("restart recovery doesn't run for this workspace");
		expect(barText).not.toMatch(/d0001|d0002|q0001|foo/u);

		const state = JSON.parse(readFileSync(harness.paths("foo").state, "utf8"));
		expect(state.restartWake).toMatchObject({ serverStartedAt: SERVER_STARTED_AT, sentAt: expect.any(String) });

		// Sent: nothing again on later ticks of this server start.
		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + 30 * MIN);
		await harness.watchdog.tick();
		expect(restartWakes(harness.requests)).toEqual([]);
	});

	it("sends after watchdog.stall.restartGraceMin when recovery's pass doesn't come, and says so", async () => {
		const harness = harnessWith(SIDEBAR_CONFIG, {
			readRestartPass: () => fooPass({ resuming: true }),
		});
		observeRestarted(harness, "foo");
		await harness.watchdog.tick();
		expect(restartWakes(harness.requests)).toEqual([]);
		harness.setNow(WATCHDOG_NOW + MIN);
		await harness.watchdog.tick();
		const [wake] = restartWakes(harness.requests);
		expect(textOf(wake)).toContain("restart recovery found no card that lost its agent");
	});

	it("an unclean stop: only a periodic manifest, or none, is no stop record", () => {
		const periodic: RestartManifest = {
			at: new Date(WATCHDOG_NOW - 4 * MIN).toISOString(),
			kanbanStart: new Date(PREVIOUS_SERVER_STARTED_AT).toISOString(),
			source: "periodic",
			cards: [],
		};
		expect(describePreviousStop(periodic, SERVER_STARTED_AT, PREVIOUS_SERVER_STARTED_AT)).toEqual({
			kind: "unclean",
			at: periodic.at,
		});
		expect(describePreviousStop(null, SERVER_STARTED_AT, PREVIOUS_SERVER_STARTED_AT)).toEqual({
			kind: "unclean",
			at: null,
		});
		const prepared = { ...periodic, source: "prepare" as const };
		expect(describePreviousStop(prepared, SERVER_STARTED_AT, PREVIOUS_SERVER_STARTED_AT).kind).toBe("planned");
		// This very server's own shutdown write is for the next start, not about this one.
		const own = { ...periodic, source: "shutdown" as const, kanbanStart: new Date(SERVER_STARTED_AT).toISOString() };
		expect(describePreviousStop(own, SERVER_STARTED_AT, PREVIOUS_SERVER_STARTED_AT).kind).toBe("unclean");
	});

	it("an unclean stop is worded as one, with the last periodic manifest's time", async () => {
		const harness = harnessWith({ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } });
		const path = getRestartManifestPath("bar", harness.home);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				at: new Date(WATCHDOG_NOW - 4 * MIN).toISOString(),
				kanbanStart: new Date(PREVIOUS_SERVER_STARTED_AT).toISOString(),
				source: "periodic",
				cards: [],
			}),
		);
		observeRestarted(harness, "bar");
		await harness.watchdog.tick();
		expect(textOf(restartWakes(harness.requests)[0])).toContain(
			"the previous server did not stop cleanly (no shutdown record; its last restart manifest is of 2026-10-07 11:56:00Z)",
		);
	});

	it("with the workspace's wakes off it goes to that workspace's ATTENTION.md instead", async () => {
		const harness = harnessWith({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: { bar: { orchestrator: { wake: { enabled: false } } } },
		});
		observeRestarted(harness, "bar");
		await harness.watchdog.tick();
		expect(harness.requests).toEqual([]);
		const attention = readFileSync(harness.paths("bar").attention, "utf8");
		expect(attention).toContain("Kanban restarted at 2026-10-07 11:59:30Z");
		expect(attention).not.toContain("this session");
	});

	it("workspaces.<id>.orchestrator.wake.restart: false turns it off for that workspace only", async () => {
		const harness = harnessWith({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: { bar: { orchestrator: { wake: { restart: false } } } },
		});
		observeRestarted(harness, "bar");
		observeRestarted(harness, "baz");
		await harness.watchdog.tick();
		expect(restartWakes(harness.requests).map((request) => "workspaceId" in request && request.workspaceId)).toEqual([
			"baz",
		]);
	});

	it("a second worker life in the same server start sends nothing; the next server start sends again", async () => {
		const first = harnessWith({ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } });
		observeRestarted(first, "bar");
		await first.watchdog.tick();
		expect(restartWakes(first.requests)).toHaveLength(1);

		const second = harnessWith(
			{ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } },
			{ home: first.home },
		);
		second.setNow(WATCHDOG_NOW + 5 * MIN);
		observeRestarted(second, "bar");
		await second.watchdog.tick();
		expect(restartWakes(second.requests)).toEqual([]);

		second.observe({
			workspaceId: "bar",
			board: createBoard({}),
			sessions: [{ ...sidebarBeforeRestart("bar"), startedAt: WATCHDOG_NOW + MIN }],
			serverStartedAt: WATCHDOG_NOW + 4 * MIN,
			previousServerStartedAt: SERVER_STARTED_AT,
		});
		await second.watchdog.tick();
		expect(restartWakes(second.requests)).toHaveLength(1);
		expect(textOf(restartWakes(second.requests)[0])).toContain("Kanban restarted at 2026-10-07 12:04:00Z");
	});

	it("doesn't wake a workspace that has no orchestrator (no sidebar summary, never woken)", async () => {
		const harness = harnessWith({ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } });
		observeRestarted(harness, "never", []);
		await harness.watchdog.tick();
		expect(harness.requests).toEqual([]);
		expect(existsSync(harness.paths("never").attention)).toBe(false);
		const decisions = readFileSync(harness.paths("never").decisions, "utf8");
		expect(decisions).toContain("no restart wake, the workspace has no orchestrator");
	});

	it("a workspace whose orchestrator the watchdog woke before (a headless run) is woken", async () => {
		const harness = harnessWith({ watchdog: { mode: "on" } }, { headlessPid: 0 });
		const statePath = harness.paths("bar").state;
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({ woken: { "earlier item": new Date(WATCHDOG_NOW - 3_600_000).toISOString() } }),
		);
		observeRestarted(harness, "bar", []);
		await harness.watchdog.tick();
		expect(harness.startHeadlessRun).toHaveBeenCalledTimes(1);
		const queue = readFileSync(harness.paths("bar").orchestratorQueue, "utf8");
		expect(queue).toContain("[bar]");
		expect(queue).toContain("Kanban restarted");
		expect(queue).toContain("this is a headless run, without the sidebar's conversation");
	});

	it("a live sidebar with a half-typed draft is held, not typed into, and gets the wake once the input clears", async () => {
		// Only Date: the session manager's typing rule reads it, the watchdog has its own clock.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(WATCHDOG_NOW);
		const taskId = "__home_agent__:foo:claude";
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ [taskId]: liveSummary(taskId) });
		const ptyWrites: string[] = [];
		const entry = (manager as unknown as { entries: Map<string, { active: unknown }> }).entries.get(taskId);
		if (!entry) {
			throw new Error("no entry");
		}
		entry.active = {
			session: { write: (data: Buffer) => ptyWrites.push(data.toString("utf8")) },
			typedSinceEnter: false,
			viewerSubmittedAt: null,
			viewerTypedAt: null,
			awaitingCodexPromptAfterEnter: false,
		};
		const delivered: string[] = [];
		const hold = createTypedInputHold({
			getTerminal: (workspaceId) => (workspaceId === "foo" ? manager : null),
			deliver: async (_terminal, _taskId, text) => {
				delivered.push(text);
				return { ok: true, status: "delivered", evidence: "state", enterAttempts: 1, summary: null };
			},
			log: () => {},
		});
		const handle = createWatchdogActionHandler({
			getWorkspacePathById: (workspaceId) => `/projects/${workspaceId}`,
			getTerminal: async () => manager,
			startTaskSession: async () => ({ ok: true, summary: null }),
			runProcessSweep: async () => ({ supported: false, lastSweep: null }),
			onBoardMutated: async () => {},
			inputHold: hold,
		});
		const harness = harnessWith(
			{ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } },
			{ handleRequest: async (request) => (request.kind === "deliverInput" ? await handle(request) : undefined) },
		);
		manager.writeInput(taskId, Buffer.from("half a message"), { fromViewer: true });
		// The browser started this sidebar after the restart: a fresh conversation.
		observeRestarted(harness, "foo", [
			{
				taskId,
				agentId: "claude",
				modelId: null,
				state: "awaiting_review",
				pid: 1234,
				startedAt: WATCHDOG_NOW - 10_000,
				live: true,
			},
		]);
		await harness.watchdog.tick();

		expect(restartWakes(harness.requests)).toHaveLength(1);
		expect(ptyWrites).toEqual(["half a message"]);
		expect(delivered).toEqual([]);
		expect(hold.pending("foo", taskId)).toBe(1);
		// Held counts as delivered: not typed again on the next tick.
		const state = JSON.parse(readFileSync(harness.paths("foo").state, "utf8"));
		expect(state.restartWake.sentAt).not.toBeNull();
		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + MIN);
		await harness.watchdog.tick();
		expect(restartWakes(harness.requests)).toEqual([]);

		manager.writeInput(taskId, Buffer.from("\r"), { fromViewer: true });
		vi.setSystemTime(WATCHDOG_NOW + VIEWER_TYPING_QUIET_MS);
		expect(await hold.flush()).toBe(1);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("Kanban restarted at 2026-10-07 11:59:30Z");
		expect(delivered[0]).toContain("this orchestrator session is fresh");
	});
});

describe("summarizeRestartRecords", () => {
	it("reads report-only and PID-pressure records", () => {
		expect(
			summarizeRestartRecords([
				restartRecord("d0001", "resume", "report", "orphaned (in_progress): ...; would resume on the same model"),
				restartRecord("d0002", "resume", "acted", "orphaned (in_progress): ...; resuming"),
				restartRecord("d0002", "resume", "none", "PID pressure; waiting before resuming"),
				restartRecord("d0003", "resume", "acted", "orphaned (review): ...; resuming"),
				restartRecord("d0003", "resume", "none", "left In Progress/Review before it was resumed"),
			]),
		).toEqual({
			orphans: 3,
			resumed: [],
			notResumed: [],
			pending: ["d0002"],
			qaReplaced: [],
			reportOnly: ["resume d0001"],
		});
	});
});

function liveSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "claude",
		modelId: null,
		reasoningEffort: null,
		workspacePath: "/projects/foo",
		pid: 1234,
		startedAt: WATCHDOG_NOW - 10_000,
		updatedAt: WATCHDOG_NOW - 10_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}
