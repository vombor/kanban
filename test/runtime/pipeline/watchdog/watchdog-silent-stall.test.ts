import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PipelineSessionView } from "../../../../src/pipeline/engine";
import { textMessage, toolUse, writeFakeClineSession } from "../../../utilities/fake-cline-sessions";
import { createWatchdogHarness, WATCHDOG_NOW } from "../../../utilities/watchdog";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

const MIN = 60_000;
const harnesses: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function readDecisions(path: string): Array<{ kind: string; outcome: string; note: string; taskId: string | null }> {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}

const runningCline: PipelineSessionView = {
	taskId: "d0001",
	agentId: "cline",
	modelId: null,
	state: "running",
	startedAt: WATCHDOG_NOW - 60 * MIN,
	stateChangedAt: WATCHDOG_NOW - 60 * MIN,
	lastOutputAt: WATCHDOG_NOW,
	updatedAt: WATCHDOG_NOW,
	workspacePath: "/wt/d0001",
	pid: 3,
	live: true,
};

// One owner for a silent stall: recovery nudges it; the watchdog's stall check never types into the card.
describe("watchdog: silent Cline stalls are only reported", () => {
	function setup(
		recoveryMode: "on" | "report",
		options: {
			workspace?: Record<string, unknown>;
			tool?: ReturnType<typeof toolUse>;
			runningTool?: string | null;
		} = {},
	) {
		const harness = createWatchdogHarness({ findRunningTool: async () => options.runningTool ?? null });
		harnesses.push(harness);
		// Cline's data dir in the harness's temp home, so the watchdog's real reader finds the fake session files.
		const dataDir = join(harness.home, "cline-data");
		harness.setConfig({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			pipeline: { recovery: { mode: recoveryMode } },
			workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" }, ...options.workspace } },
			agents: { cline: { dataDir } },
		});
		writeFakeClineSession(join(dataDir, "sessions"), {
			sessionId: "1791411324706_pzwiv",
			cwd: "/wt/d0001",
			status: "idle",
			startedAt: WATCHDOG_NOW - 60 * MIN,
			messages: [
				textMessage("user", "Fix the admin coupons page.", WATCHDOG_NOW - 30 * MIN),
				options.tool ?? toolUse("editor", WATCHDOG_NOW - 13 * MIN, { path: "/wt/d0001/scripts/probe.cjs" }),
			],
		});
		harness.observe({
			workspaceId: "foo",
			board: createBoard({ in_progress: [createCard({ id: "d0001", updatedAt: WATCHDOG_NOW - 60 * MIN })] }),
			sessions: [runningCline],
		});
		return harness;
	}

	it("logs it as recovery's where recovery acts: no continue, no ATTENTION item", async () => {
		const harness = setup("on");
		await harness.watchdog.tick();
		expect(harness.requests.filter((request) => "taskId" in request && request.taskId === "d0001")).toEqual([]);
		expect(readDecisions(harness.paths("foo").decisions)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "stall",
					taskId: "d0001",
					outcome: "skipped",
					note: expect.stringMatching(/a tool call \(editor\) with no result.*; recovery owns it$/u),
				}),
			]),
		);
		const attention = existsSync(harness.paths("foo").attention)
			? readFileSync(harness.paths("foo").attention, "utf8")
			: "";
		expect(attention).not.toContain("d0001");
	});

	it("makes it an item where recovery doesn't act, still without typing into the card", async () => {
		const harness = setup("report");
		await harness.watchdog.tick();
		expect(harness.requests.filter((request) => request.kind === "deliverInput")).toEqual([]);
		expect(readDecisions(harness.paths("foo").decisions)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "stall",
					taskId: "d0001",
					outcome: "acted",
					note: expect.stringContaining("nothing nudges it (pipeline.recovery.mode is report)"),
				}),
			]),
		);
		const wake = harness.requests.find((request) => request.kind === "startOrchestratorSession");
		expect(wake && "prompt" in wake ? wake.prompt : "").toContain("its Cline session is silent");
	});

	it("names why nothing nudges it: recovery on, but off for this workspace", async () => {
		const harness = setup("on", { workspace: { recovery: { enabled: false } } });
		await harness.watchdog.tick();
		expect(readDecisions(harness.paths("foo").decisions)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					taskId: "d0001",
					note: expect.stringContaining(
						"nothing nudges it (recovery is disabled for this workspace (workspaces.<id>.recovery.enabled))",
					),
				}),
			]),
		);
	});

	it("says nothing about a long run_commands call whose command still runs", async () => {
		const harness = setup("report", {
			tool: toolUse("run_commands", WATCHDOG_NOW - 20 * MIN, { commands: ["npm test"] }),
			runningTool: "pid 9001: npm test",
		});
		await harness.watchdog.tick();
		expect(readDecisions(harness.paths("foo").decisions).filter((record) => record.taskId === "d0001")).toEqual([]);
	});

	it("says nothing while the session is still within stallNudgeMin", async () => {
		const harness = setup("report");
		harness.setNow(WATCHDOG_NOW - 6 * MIN);
		await harness.watchdog.tick();
		expect(readDecisions(harness.paths("foo").decisions).filter((record) => record.taskId === "d0001")).toEqual([]);
	});
});

// Issue #9: a Cline TUI on its sign-in screen writes no session file while Kanban says "running".
describe("watchdog: a Cline run that never wrote a session file", () => {
	function setup(role: "dev" | "qa", recoveryMode: "on" | "report", options: { providers?: unknown } = {}) {
		const harness = createWatchdogHarness({ findRunningTool: async () => null });
		harnesses.push(harness);
		const dataDir = join(harness.home, "cline-data");
		harness.setConfig({
			watchdog: { mode: "on" },
			orchestrator: { wake: { mode: "sidebar" } },
			pipeline: { recovery: { mode: recoveryMode } },
			workspaces: { foo: { landing: { mode: "qa" }, kit: { name: "team" } } },
			agents: { cline: { dataDir } },
		});
		if (options.providers !== undefined) {
			mkdirSync(join(dataDir, "settings"), { recursive: true });
			writeFileSync(join(dataDir, "settings", "providers.json"), JSON.stringify(options.providers));
		}
		harness.observe({
			workspaceId: "foo",
			board: createBoard({
				in_progress: [
					createCard({
						id: "d0001",
						role,
						agentId: "cline",
						agentSettings: { providerId: "bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
						updatedAt: WATCHDOG_NOW - 60 * MIN,
					}),
				],
			}),
			sessions: [{ ...runningCline, startedAt: WATCHDOG_NOW - 9 * MIN, stateChangedAt: WATCHDOG_NOW - 9 * MIN }],
		});
		return harness;
	}

	const noKey = {
		version: 1,
		providers: { bedrock: { settings: { provider: "bedrock", aws: { region: "us-west-2" } } } },
	};

	it("makes a QA card an ATTENTION item that names the sign-in screen, without typing into it", async () => {
		const harness = setup("qa", "on", { providers: noKey });
		await harness.watchdog.tick();
		expect(harness.requests.filter((request) => request.kind === "deliverInput")).toEqual([]);
		expect(readDecisions(harness.paths("foo").decisions)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "stall",
					taskId: "d0001",
					note: expect.stringContaining(
						"qa card is running but Cline is asking for sign-in: no Cline session file since 2026-",
					),
				}),
			]),
		);
		const wake = harness.requests.find((request) => request.kind === "startOrchestratorSession");
		expect(wake && "prompt" in wake ? wake.prompt : "").toContain(
			"providers.json stores no Bedrock key (Cline's TUI doesn't count AWS_BEARER_TOKEN_BEDROCK)",
		);
	});

	it("leaves a dev card's to recovery where recovery acts (it escalates)", async () => {
		const harness = setup("dev", "on", { providers: noKey });
		await harness.watchdog.tick();
		expect(readDecisions(harness.paths("foo").decisions)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "stall",
					taskId: "d0001",
					outcome: "skipped",
					note: expect.stringMatching(/dev card is running but Cline is asking for sign-in.*; recovery owns it$/u),
				}),
			]),
		);
	});

	it("says it never took the prompt when Cline's settings look complete, and waits stallNudgeMin", async () => {
		const harness = setup("qa", "on", {
			providers: {
				providers: { bedrock: { settings: { provider: "bedrock", apiKey: "k", aws: { region: "us-west-2" } } } },
			},
		});
		harness.setNow(WATCHDOG_NOW - 2 * MIN);
		await harness.watchdog.tick();
		expect(readDecisions(harness.paths("foo").decisions).filter((record) => record.taskId === "d0001")).toEqual([]);
		harness.setNow(WATCHDOG_NOW);
		await harness.watchdog.tick();
		expect(readDecisions(harness.paths("foo").decisions)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "d0001", note: expect.stringContaining("Cline never took the prompt") }),
			]),
		);
	});
});
