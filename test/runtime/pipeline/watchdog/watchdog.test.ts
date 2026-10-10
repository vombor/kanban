import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import { addWakeRequest } from "../../../../src/pipeline/watchdog/wake-requests";
import { getPidPressureFlagPaths } from "../../../../src/state/kanban-home";
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

const QA_FOO = { foo: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } } };

function readDecisions(path: string): Array<{ kind: string; outcome: string; note: string; taskId: string | null }> {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}

// A Claude card stuck on the trust dialog: running for 10 min with no hook since its start.
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

describe("watchdog modes", () => {
	it("off (the default) does nothing at all", async () => {
		const harness = harnessWith({ workspaces: QA_FOO });
		harness.observe({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "d0001", updatedAt: WATCHDOG_NOW - 60 * MIN })] }),
		});
		await harness.watchdog.tick();
		expect(harness.requests).toEqual([]);
		expect(existsSync(harness.paths("foo").decisions)).toBe(false);
		expect(existsSync(harness.paths("foo").attention)).toBe(false);
	});

	it("report decides and logs, and acts on nothing", async () => {
		const harness = harnessWith(
			{ watchdog: { mode: "report" }, workspaces: QA_FOO },
			{ pidUsage: { current: 95, max: 100 } },
		);
		harness.observe({
			workspaceId: "foo",
			board: createBoard({
				review: [createCard({ id: "d0001", updatedAt: WATCHDOG_NOW - 60 * MIN })],
				in_progress: [createCard({ id: "d0002", updatedAt: WATCHDOG_NOW - 60 * MIN })],
			}),
			sessions: [
				{
					taskId: "d0002",
					agentId: "cline",
					modelId: null,
					state: "running",
					updatedAt: WATCHDOG_NOW - 60 * MIN,
					pid: 3,
				},
			],
		});
		harness.observe({ workspaceId: "plain", board: createBoard({}) });
		await harness.watchdog.tick();
		expect(harness.requests).toEqual([]);
		expect(harness.startHeadlessRun).not.toHaveBeenCalled();
		// Nothing to report for a quiet workspace on the default kit: not even its data dir.
		expect(existsSync(harness.paths("plain").dataDir)).toBe(false);
		expect(existsSync(harness.paths("foo").attention)).toBe(false);
		expect(existsSync(harness.paths("foo").state)).toBe(false);
		expect(existsSync(getPidPressureFlagPaths(harness.home).pressure)).toBe(false);
		const decisions = readDecisions(harness.paths("foo").decisions);
		expect(decisions.every((decision) => decision.outcome === "report" || decision.outcome === "skipped")).toBe(true);
		expect(decisions.map((decision) => decision.kind)).toEqual(
			expect.arrayContaining(["stall", "pause", "attention", "wake", "job"]),
		);
	});
});

describe("watchdog on", () => {
	it("a workspace on the default kit with landing off gets only the stuck-prompt check", async () => {
		const harness = harnessWith({ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } });
		harness.observe({
			workspaceId: "plain",
			board: createBoard({
				review: [createCard({ id: "d0001", updatedAt: WATCHDOG_NOW - 60 * MIN })],
				in_progress: [
					createCard({ id: "d0002", updatedAt: WATCHDOG_NOW - 60 * MIN }),
					createCard({ id: "d0003", updatedAt: WATCHDOG_NOW - 60 * MIN }),
				],
				trash: [createCard({ id: "old01", updatedAt: WATCHDOG_NOW - 30 * 86_400_000 })],
			}),
			sessions: [
				{
					taskId: "d0002",
					agentId: "claude",
					modelId: null,
					state: "idle",
					updatedAt: WATCHDOG_NOW - 60 * MIN,
					pid: 2,
				},
				stuckOnPrompt("d0003"),
			],
		});
		await harness.watchdog.tick();
		// No continue, no review stall, no prune: only the prompt item, which wakes the orchestrator.
		expect(harness.requests.map((request) => request.kind)).toEqual(["startOrchestratorSession"]);
		const attention = readFileSync(harness.paths("plain").attention, "utf8");
		expect(attention).toContain("- **d0003** (prompt): claude card started");
		expect(attention).not.toContain("d0001");
	});

	it("writes ATTENTION.md, sends one continue, prunes hourly and saves its state", async () => {
		const harness = harnessWith({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: QA_FOO,
		});
		const paths = harness.paths("foo");
		mkdirSync(dirname(paths.attention), { recursive: true });
		writeFileSync(paths.attention, "## Orchestrator: needs the user\n- **bb001**: choose\n");
		writeFileSync(paths.qaLog, "## TRIAGE e0001: needs decision (10:00Z)\n");
		writeFileSync(
			`${paths.dataDir}/pipeline-state.json`,
			JSON.stringify({
				version: 1,
				since: "2026-10-01T00:00:00.000Z",
				importedFrom: null,
				cards: {
					e0001: { qaflow: { escalated: { at: "2026-10-07T09:00:00Z", reason: "3 FAILs" } } },
					f0001: { qaflow: { stopped: { at: "2026-10-07T09:30:00Z", reason: "the kit does not rework" } } },
				},
			}),
		);
		const board = createBoard({
			review: [
				createCard({ id: "e0001", updatedAt: WATCHDOG_NOW - 60 * MIN }),
				createCard({ id: "f0001", updatedAt: WATCHDOG_NOW - 60 * MIN }),
				createCard({ id: "bb001", updatedAt: WATCHDOG_NOW - 60 * MIN }),
			],
			in_progress: [createCard({ id: "d0002", updatedAt: WATCHDOG_NOW - 60 * MIN })],
		});
		const sessions: PipelineSessionView[] = [
			{ taskId: "d0002", agentId: "cline", modelId: null, state: "idle", updatedAt: WATCHDOG_NOW - 8 * MIN, pid: 2 },
		];
		harness.observe({ workspaceId: "foo", board, sessions });
		await harness.watchdog.tick();

		const attention = readFileSync(paths.attention, "utf8");
		expect(attention).toContain(
			"- **e0001** (review): escalated 2026-10-07T09:00:00Z (3 FAILs); triage: needs decision",
		);
		expect(attention).toContain(
			"- **f0001** (review): stopped 2026-10-07T09:30:00Z (the kit does not rework); the kit does not rework it",
		);
		expect(attention).not.toContain("f0001:review-stall");
		expect(attention).toContain("## Orchestrator: needs the user\n- **bb001**: choose");
		expect(harness.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "deliverInput", taskId: "d0002" }),
				expect.objectContaining({ kind: "pruneDone", workspaceId: "foo", days: 3 }),
				expect.objectContaining({ kind: "startOrchestratorSession", workspaceId: "foo" }),
			]),
		);
		// bb001 is an open user item: not a review-stall wake.
		const start = harness.requests.find((request) => request.kind === "startOrchestratorSession");
		expect(start && "prompt" in start ? start.prompt : "").not.toContain("bb001");
		const state = JSON.parse(readFileSync(paths.state, "utf8"));
		expect(Object.keys(state.resumed)).toEqual([`d0002:${WATCHDOG_NOW - 8 * MIN}`]);
		expect(state.jobs["prune-done"]).toBe(new Date(WATCHDOG_NOW).toISOString());

		// Ten minutes later: no second continue for the same dead session, no second prune within the hour.
		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + 10 * MIN);
		await harness.watchdog.tick();
		expect(harness.requests.map((request) => request.kind)).not.toContain("pruneDone");
		expect(
			harness.requests.filter((request) => request.kind === "deliverInput" && request.taskId === "d0002"),
		).toEqual([]);
	});

	it("post-restart: a Review card whose dead QA card the gate did not replace within the grace wakes only its own orchestrator", async () => {
		const harness = harnessWith({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: {
				...QA_FOO,
				bar: { landing: { mode: "qa" }, kit: { name: "team" }, models: { allowProvisional: true } },
			},
		});
		const serverStartedAt = WATCHDOG_NOW - 70_000;
		const paths = harness.paths("foo");
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(
			`${paths.dataDir}/pipeline-state.json`,
			JSON.stringify({
				version: 1,
				since: "2026-10-01T00:00:00.000Z",
				importedFrom: null,
				cards: {
					"6f756": { qaCard: "q6f75", qaCreated: "abcdef0123456789" },
					q6f75: {
						qaGate: {
							reviewsTaskId: "6f756",
							round: 1,
							snapshot: "abcdef0123456789",
							snapshotRef: "refs/kanban/snapshots/6f756",
							outboxDir: "/tmp/outbox",
							scratchDir: "/tmp/scratch",
							baseRef: "main",
							agentId: "claude",
							model: null,
							devAgentId: "cline",
							devModel: null,
							route: null,
							status: "running",
							createdAt: serverStartedAt - 30 * MIN,
							startedAt: serverStartedAt - 29 * MIN,
						},
					},
				},
			}),
		);
		// Long enough in Review for the generic stall too: the restart item replaces it.
		harness.observe({
			workspaceId: "foo",
			serverStartedAt,
			board: createBoard({
				review: [createCard({ id: "6f756", updatedAt: WATCHDOG_NOW - 20 * MIN })],
				in_progress: [createCard({ id: "q6f75", role: "qa", reviewsTaskId: "6f756", updatedAt: serverStartedAt })],
			}),
			sessions: [
				{
					taskId: "q6f75",
					agentId: "claude",
					modelId: null,
					state: "interrupted",
					startedAt: serverStartedAt - 29 * MIN,
					pid: null,
					live: false,
				},
			],
		});
		harness.observe({ workspaceId: "bar", serverStartedAt, board: createBoard({}) });
		await harness.watchdog.tick();

		const wakes = harness.requests.filter((request) => request.kind === "startOrchestratorSession");
		expect(wakes).toEqual([expect.objectContaining({ workspaceId: "foo", fromWorkspaceId: "foo" })]);
		const prompt = wakes[0] && "prompt" in wakes[0] ? wakes[0].prompt : "";
		expect(prompt).toContain(
			"6f756: dev card is in Review and the automatic QA replacement didn't happen: its QA card q6f75",
		);
		expect(prompt).not.toContain("with nothing pending");
		const decisions = readDecisions(paths.decisions).filter((decision) => decision.kind === "stall");
		expect(decisions.map((decision) => decision.taskId)).toEqual(["6f756"]);
	});

	it("an empty-diff Review whose agent ran wakes its orchestrator with 'Done or restart?' (issue #14)", async () => {
		const harness = harnessWith({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: QA_FOO,
		});
		const paths = harness.paths("foo");
		mkdirSync(paths.dataDir, { recursive: true });
		const updatedAt = WATCHDOG_NOW - 2 * MIN;
		writeFileSync(
			`${paths.dataDir}/pipeline-state.json`,
			JSON.stringify({
				version: 1,
				since: "2026-10-01T00:00:00.000Z",
				importedFrom: null,
				cards: {
					b2d5b: {
						emptyDiff: {
							at: new Date(WATCHDOG_NOW - MIN).toISOString(),
							cardUpdatedAt: updatedAt,
							snapshot: "9a631654aaaaaaaa",
							parent: "302326a2bbbbbbbb",
							baseRef: "main",
							ran: true,
							evidence: "its turn ended through the agent's hook",
						},
					},
				},
			}),
		);
		harness.observe({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "b2d5b", updatedAt })] }),
			sessions: [
				{
					taskId: "b2d5b",
					agentId: "cline",
					modelId: null,
					state: "awaiting_review",
					reviewReason: "hook",
					updatedAt,
					pid: 3,
				},
			],
		});
		await harness.watchdog.tick();

		const wakes = harness.requests.filter((request) => request.kind === "startOrchestratorSession");
		expect(wakes).toEqual([expect.objectContaining({ workspaceId: "foo", fromWorkspaceId: "foo" })]);
		const prompt = wakes[0] && "prompt" in wakes[0] ? wakes[0].prompt : "";
		expect(prompt).toContain("b2d5b: dev card ran but changed nothing: no changes against main");
		expect(prompt).toContain("Done or restart?");
		// Reported, never moved: nothing asks the server to finish the card.
		expect(harness.requests.map((request) => request.kind)).not.toContain("finishTask");
	});

	it("a Review card waiting for a permission answer is reported as that, not also as a Review stall", async () => {
		const harness = harnessWith({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: QA_FOO,
		});
		const paths = harness.paths("foo");
		harness.observe({
			workspaceId: "foo",
			board: createBoard({ review: [createCard({ id: "c0001", updatedAt: WATCHDOG_NOW - 60 * MIN })] }),
			sessions: [
				{
					taskId: "c0001",
					agentId: "claude",
					modelId: null,
					state: "awaiting_review",
					reviewReason: "attention",
					startedAt: WATCHDOG_NOW - 70 * MIN,
					updatedAt: WATCHDOG_NOW - 20 * MIN,
					lastHookAt: WATCHDOG_NOW - 20 * MIN,
					latestHookActivity: {
						activityText: "Bash: npm publish",
						toolName: "Bash",
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "PermissionRequest",
						notificationType: null,
						source: "claude",
					},
					pid: 4,
				},
			],
		});
		await harness.watchdog.tick();

		expect(readFileSync(paths.attention, "utf8")).toContain(
			"- **c0001** (prompt): claude card is waiting for a permission answer",
		);
		const stalls = readDecisions(paths.decisions).filter((decision) => decision.kind === "stall");
		expect(stalls).toEqual([]);
	});

	it("PID pressure: flags, a process sweep, the ATTENTION line, no wake for it; brownout pauses running agents once", async () => {
		const harness = harnessWith(
			{ watchdog: { mode: "on" }, workspaces: QA_FOO },
			{ pidUsage: { current: 95, max: 100 } },
		);
		harness.observe({
			workspaceId: "foo",
			board: createBoard({ in_progress: [createCard({ id: "d0001", updatedAt: WATCHDOG_NOW })] }),
			sessions: [
				{ taskId: "d0001", agentId: "cline", modelId: null, state: "running", updatedAt: WATCHDOG_NOW, pid: 3 },
			],
		});
		await harness.watchdog.tick();
		const flags = getPidPressureFlagPaths(harness.home);
		expect(readFileSync(flags.pressure, "utf8")).toBe("95/100\n");
		expect(existsSync(flags.brownout)).toBe(true);
		expect(harness.requests.map((request) => request.kind)).toEqual(["sweepProcesses", "interrupt", "pruneDone"]);
		expect(readFileSync(harness.paths("foo").attention, "utf8")).toContain(
			"**PID pressure**: 95/100 PIDs in use (mostly zombies under PID 1). New QA cards and calibration waves are held; BROWNOUT",
		);
		expect(readFileSync(harness.paths("foo").attention, "utf8")).toContain("found 7 zombie(s)");

		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + MIN);
		await harness.watchdog.tick();
		expect(harness.requests.map((request) => request.kind)).toEqual([]);

		harness.setPidUsage({ current: 10, max: 100 });
		harness.setNow(WATCHDOG_NOW + 2 * MIN);
		await harness.watchdog.tick();
		expect(existsSync(flags.pressure)).toBe(false);
		expect(existsSync(flags.brownout)).toBe(false);
	});

	it("a paused QA pipeline: one ATTENTION line with the held QA cards, no review stall, no wake for it", async () => {
		const harness = harnessWith({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			workspaces: { foo: { ...QA_FOO.foo, pipeline: { paused: true, pausedAt: "2026-10-07T09:00:00.000Z" } } },
		});
		const paths = harness.paths("foo");
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(
			`${paths.dataDir}/pipeline-state.json`,
			JSON.stringify({
				version: 1,
				since: "2026-10-01T00:00:00.000Z",
				importedFrom: null,
				cards: {
					d0001: { qaCard: "qa001" },
					qa001: {
						qaGate: {
							status: "queued",
							reviewsTaskId: "d0001",
							round: 1,
							snapshot: "snap-d0001",
							snapshotRef: "refs/kanban/snapshots/d0001",
							outboxDir: "/tmp/kanban-qa-out/qa001",
							scratchDir: "/tmp/kanban-qa/d0001",
							baseRef: "main",
							agentId: "cline",
							model: null,
							devAgentId: "cline",
							devModel: null,
							route: null,
							createdAt: WATCHDOG_NOW - 60 * MIN,
						},
					},
				},
			}),
		);
		harness.observe({
			workspaceId: "foo",
			board: createBoard({
				review: [
					createCard({ id: "d0001", updatedAt: WATCHDOG_NOW - 60 * MIN }),
					createCard({ id: "d0002", updatedAt: WATCHDOG_NOW - 60 * MIN }),
				],
				backlog: [
					createCard({ id: "qa001", role: "qa", reviewsTaskId: "d0001", updatedAt: WATCHDOG_NOW - 60 * MIN }),
				],
			}),
			sessions: [],
		});
		await harness.watchdog.tick();

		const attention = readFileSync(paths.attention, "utf8");
		expect(attention).toContain(
			"- **QA paused**: the QA pipeline is paused since 2026-10-07T09:00:00.000Z: 1 QA card(s) wait in Backlog (qa001); no PASS lands and no rework is sent until `kanban pipeline resume`.",
		);
		expect(attention).not.toContain("review-stall");
		expect(readDecisions(paths.decisions).filter((decision) => decision.kind === "stall")).toEqual([]);
		expect(harness.requests.map((request) => request.kind)).not.toContain("startOrchestratorSession");
	});

	it("wake requests: immediate, and --when-card-done once the card is Done", async () => {
		const harness = harnessWith({ watchdog: { mode: "on" }, orchestrator: { wake: { mode: "sidebar" } } });
		const paths = harness.paths("plain");
		await addWakeRequest(paths.wakeRequests, { issue: "look at the plan", when: null, now: new Date(WATCHDOG_NOW) });
		await addWakeRequest(paths.wakeRequests, {
			issue: "audit finished: create fix cards",
			when: { kind: "card-done", taskId: "a0001" },
			now: new Date(WATCHDOG_NOW),
		});
		harness.observe({
			workspaceId: "plain",
			board: createBoard({ in_progress: [createCard({ id: "a0001ff", updatedAt: WATCHDOG_NOW })] }),
		});
		await harness.watchdog.tick();
		const first = harness.requests.find((request) => request.kind === "startOrchestratorSession");
		expect(first && "prompt" in first ? first.prompt : "").toContain("look at the plan");
		expect(first && "prompt" in first ? first.prompt : "").not.toContain("audit finished");
		expect(JSON.parse(readFileSync(paths.wakeRequests, "utf8")).requests).toHaveLength(1);

		harness.requests.length = 0;
		harness.setNow(WATCHDOG_NOW + MIN);
		harness.observe({
			workspaceId: "plain",
			board: createBoard({ trash: [createCard({ id: "a0001ff", updatedAt: WATCHDOG_NOW })] }),
			sessions: [
				{
					taskId: "__home_agent__:plain:claude",
					agentId: "claude",
					modelId: null,
					state: "awaiting_review",
					pid: 9,
				},
			],
		});
		await harness.watchdog.tick();
		const second = harness.requests.find((request) => request.kind === "deliverInput");
		expect(second && "text" in second ? second.text : "").toContain("audit finished: create fix cards");
		expect(JSON.parse(readFileSync(paths.wakeRequests, "utf8")).requests).toEqual([]);
	});
});
