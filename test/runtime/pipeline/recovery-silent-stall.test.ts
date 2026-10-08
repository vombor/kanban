import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getWorkspacePipelineSettings, parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard, RuntimeBoardData } from "../../../src/core/api-contract";
import type { PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import type { PipelineSessionView } from "../../../src/pipeline/engine";
import type { RecoveryFlowPatch } from "../../../src/pipeline/recovery";
import { CONTINUE_PROMPT } from "../../../src/pipeline/recovery-prompts";
import { applyRecoveryPatches } from "../../../src/pipeline/recovery-runtime";
import { createRecoveryStage, type RecoveryAction } from "../../../src/pipeline/recovery-stage";
import { createClineSessionFileReader } from "../../../src/terminal/cline-session-files";
import {
	type FakeClineMessage,
	textMessage,
	toolResult,
	toolUse,
	writeFakeClineSession,
} from "../../utilities/fake-cline-sessions";
import { createTempDir } from "../../utilities/temp-dir";

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T22:30:00.000Z");
const WORKTREE = "/wt/dev1";
const SESSION_ID = "1791411264226_ky3nx";

function card(id: string): RuntimeBoardCard {
	return { id, title: id, prompt: `Prompt of ${id}.`, startInPlanMode: false, baseRef: "main" } as RuntimeBoardCard;
}

function inProgress(...cards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({
			id,
			title: id,
			cards: id === "in_progress" ? cards : [],
		})),
		dependencies: [],
	} as unknown as RuntimeBoardData;
}

/** Kanban's view: running since `since` (output keeps coming, but output never counts). */
function running(since = T0 - 60 * MIN): PipelineSessionView {
	return {
		taskId: "dev1",
		agentId: "cline",
		modelId: null,
		state: "running",
		reviewReason: null,
		startedAt: since,
		stateChangedAt: since,
		lastOutputAt: Date.now(),
		workspacePath: WORKTREE,
		pid: 4604,
		live: true,
	};
}

describe("recovery: silent stalls of Cline cards", () => {
	let temp: ReturnType<typeof createTempDir>;
	let sessionsPath: string;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		temp = createTempDir("kanban-silent-stall-");
		sessionsPath = join(temp.path, "sessions");
	});

	afterEach(() => {
		vi.useRealTimers();
		temp.cleanup();
	});

	function writeSession(
		messages: FakeClineMessage[],
		options: { status?: "running" | "idle"; teammates?: Record<string, number> } = {},
	) {
		writeFakeClineSession(sessionsPath, {
			sessionId: SESSION_ID,
			cwd: WORKTREE,
			status: options.status ?? "running",
			startedAt: T0 - 60 * MIN,
			messages,
			teammates: options.teammates,
		});
	}

	function createHarness(
		config: Record<string, unknown> = { pipeline: { recovery: { mode: "on" } } },
		runningTool: () => string | null = () => null,
	) {
		const actions: RecoveryAction[] = [];
		const toolLookups: Array<{ worktreePath: string; agentPid: number | null }> = [];
		const records: PipelineDecisionRecord[] = [];
		let cards: Record<string, Record<string, unknown>> = {};
		const reader = createClineSessionFileReader();
		const stage = createRecoveryStage({
			locateWorktree: async () => WORKTREE,
			readSessionDetail: async (worktreePath) => await reader.readLatestSessionDetail(sessionsPath, worktreePath),
			findRunningTool: async (worktreePath, agentPid) => {
				toolLookups.push({ worktreePath, agentPid });
				return runningTool();
			},
			canProbe: () => false,
			probe: async () => ({ up: true, detail: "200" }),
			act: async (_workspaceId, action) => {
				actions.push(action);
				return { ok: true, status: "delivered", evidence: "hook" };
			},
			cleanGeneratedReports: async () => [],
			tagRestartWip: async () => null,
			hasTrackedChanges: async () => false,
			readManifest: async () => null,
			removeManifest: async () => {},
			markManifestPlanned: async () => {},
			consumeRecoverRequest: async () => false,
			updateCards: async (_workspaceId, patches: ReadonlyMap<string, RecoveryFlowPatch>) => {
				cards = applyRecoveryPatches(cards, patches);
			},
			appendRecords: async (next) => {
				records.push(...next);
			},
			sleep: async () => {},
			now: () => Date.now(),
			log: () => {},
		});
		const parsed = parsePipelineConfig({ workspaces: { foo: { landing: { mode: "qa" } } }, ...config });
		const evaluate = async (session: PipelineSessionView = running()) => {
			const result = await stage.evaluate({
				snapshot: {
					workspaceId: "foo",
					workspacePath: "/projects/foo",
					selectedAgentId: "cline",
					board: inProgress(card("dev1")),
					sessions: [session],
				},
				settings: getWorkspacePipelineSettings(parsed.config, "foo"),
				config: parsed.config,
				kitName: "default",
				state: { version: 1, since: "2026-10-01T00:00:00.000Z", importedFrom: null, cards },
			});
			await stage.idle();
			return [...result, ...records.splice(0)];
		};
		const delivered = () => actions.flatMap((action) => (action.kind === "deliver" ? [action.text] : []));
		return {
			evaluate,
			actions,
			delivered,
			toolLookups,
			flow: () => cards.dev1?.qaflow as Record<string, unknown> | undefined,
		};
	}

	const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
	const prompt = textMessage("user", "Implement the profile page.", T0 - 20 * MIN);

	it("(a) tells an interrupted tool call it didn't return, after stallNudgeMin and not before", async () => {
		// 8ab87 at 22:15:08Z: apply_patch, then nothing; Cline's run ended "ok" with no tool_result.
		writeSession([prompt, toolUse("apply_patch", T0 - 7 * MIN, { input: "*** Begin Patch" })], { status: "idle" });
		const harness = createHarness();

		expect(await harness.evaluate()).toEqual([]);
		advance(2 * MIN);
		const records = await harness.evaluate();

		expect(records).toMatchObject([
			{
				stage: "recovery",
				taskId: "dev1",
				answer: { kind: "nudge", cause: "silent_stall" },
				outcome: "acted",
				note: expect.stringContaining("silent stall: a tool call (apply_patch) with no result"),
			},
		]);
		expect(harness.delivered()).toEqual([
			"Your last tool call (apply_patch) didn't return: it was interrupted and no result came back. Check the worktree (git status / git diff) to see whether it took effect, then re-run it or continue. Keep going until the whole task is done; only stop when you're finished.",
		]);
		expect(harness.flow()?.nudges).toMatchObject([{ reason: "silent_stall", poisoned: false }]);
		expect(harness.flow()?.recoverySentAt).toBe(new Date(Date.now()).toISOString());
	});

	it("(b) gives a reply without a STATUS line the usual continue", async () => {
		writeSession([prompt, textMessage("assistant", "I'll now update the routes.", T0 - 9 * MIN)], {
			status: "running",
		});
		const harness = createHarness();
		expect(await harness.evaluate()).toMatchObject([{ answer: { kind: "nudge", cause: "silent_stall" } }]);
		expect(harness.delivered()).toEqual([CONTINUE_PROMPT]);
	});

	it("leaves a reply with a STATUS line to the turn detector", async () => {
		writeSession([prompt, textMessage("assistant", "All done.\nSTATUS: DONE", T0 - 30 * MIN)], { status: "idle" });
		const harness = createHarness();
		expect(await harness.evaluate()).toEqual([]);
		expect(harness.actions).toEqual([]);
	});

	it("(c) continues an idle session that never answered; a running one is the hung-request check's", async () => {
		writeSession([prompt, toolResult(T0 - 9 * MIN)], { status: "idle" });
		const idle = createHarness();
		expect(await idle.evaluate()).toMatchObject([{ answer: { kind: "nudge", cause: "silent_stall" } }]);
		expect(idle.delivered()).toEqual([CONTINUE_PROMPT]);

		// A model request in flight: no typed nudge; Esc once it counts as hung (hungMin 15).
		writeSession([prompt, toolResult(T0 - 9 * MIN)], { status: "running" });
		const inFlight = createHarness();
		expect(await inFlight.evaluate()).toEqual([]);
		advance(6 * MIN);
		expect(await inFlight.evaluate()).toMatchObject([{ answer: { kind: "cancel_hung" } }]);
		expect(inFlight.actions).toEqual([{ kind: "input", taskId: "dev1", data: "\u001b" }]);
	});

	it("doesn't cut off a long tool step: a slow test run, or teammates still writing", async () => {
		const harness = createHarness();
		// `npm test` for 7.5 min: the lead's last message is the call, nothing written meanwhile.
		writeSession([prompt, toolUse("run_commands", T0 - 7 * MIN, { commands: ["npm test"] })]);
		expect(await harness.evaluate()).toEqual([]);
		advance(30_000);
		writeSession([
			prompt,
			toolUse("run_commands", T0 - 7 * MIN, { commands: ["npm test"] }),
			toolResult(Date.now()),
			textMessage("assistant", "Tests pass. STATUS: DONE", Date.now() + 1_000),
		]);
		advance(10 * MIN);
		expect(await harness.evaluate()).toEqual([]);

		// team_await_runs for 30 min while a teammate keeps writing its own messages file: progress.
		writeSession([prompt, toolUse("team_await_runs", Date.now() - 30 * MIN)], {
			teammates: { backend__QEgF0p: Date.now() - MIN },
		});
		expect(await harness.evaluate()).toEqual([]);
		expect(harness.actions).toEqual([]);
	});

	it("starts the clock at the Kanban run's start, not at an older session file", async () => {
		writeSession([prompt, toolUse("apply_patch", T0 - 30 * MIN)], { status: "idle" });
		const harness = createHarness();
		const resumed = running(T0 - MIN);
		expect(await harness.evaluate(resumed)).toEqual([]);
		advance(6 * MIN);
		expect(await harness.evaluate(resumed)).toEqual([]);
		advance(2 * MIN);
		expect(await harness.evaluate(resumed)).toMatchObject([{ answer: { kind: "nudge", cause: "silent_stall" } }]);
	});

	it("gives each further nudge another stallNudgeMin of silence, nudges up to maxNudges, then escalates once", async () => {
		writeSession([prompt, toolUse("editor", T0 - 9 * MIN)], { status: "idle" });
		const harness = createHarness();

		expect(await harness.evaluate()).toMatchObject([{ answer: { kind: "nudge" }, outcome: "acted" }]);
		// The clock restarts at the nudge: nothing past nudgeCheckSec, nothing at 7 min.
		for (const step of [MIN, 2 * MIN, 4 * MIN]) {
			advance(step);
			expect(await harness.evaluate()).toEqual([]);
		}
		advance(MIN);
		expect(await harness.evaluate()).toMatchObject([{ answer: { kind: "nudge" }, outcome: "acted" }]);
		expect(harness.delivered()).toHaveLength(2);

		advance(7 * MIN);
		expect(await harness.evaluate()).toEqual([]);
		advance(MIN);
		const escalation = await harness.evaluate();
		expect(escalation).toMatchObject([
			{ answer: { kind: "escalate" }, note: expect.stringContaining("agent keeps stalling silently (2 nudges") },
		]);
		expect(harness.flow()?.escalated).toMatchObject({ reason: expect.stringContaining("stalling silently") });
		advance(10 * MIN);
		expect(await harness.evaluate()).toEqual([]);
		expect(harness.delivered()).toHaveLength(2);
	});

	it("never nudges or escalates a 20-minute run_commands call whose command still runs", async () => {
		writeSession([prompt, toolUse("run_commands", T0, { commands: ["npm test"] })]);
		let running: string | null = "pid 9001: npm test";
		const harness = createHarness(undefined, () => running);
		for (let minute = 1; minute <= 20; minute += 1) {
			advance(MIN);
			expect(await harness.evaluate()).toEqual([]);
		}
		expect(harness.actions).toEqual([]);
		expect(harness.flow()?.escalated).toBeUndefined();
		// Asked with the card's worktree and its agent's pid.
		expect(harness.toolLookups.at(-1)).toEqual({ worktreePath: WORKTREE, agentPid: 4604 });

		// The command returns and the agent goes on: no lookups for other tools.
		running = null;
		writeSession([
			prompt,
			toolUse("run_commands", T0, { commands: ["npm test"] }),
			toolResult(Date.now()),
			toolUse("editor", Date.now() + 1_000),
		]);
		const lookups = harness.toolLookups.length;
		advance(5 * MIN);
		expect(await harness.evaluate()).toEqual([]);
		expect(harness.toolLookups).toHaveLength(lookups);
	});

	it("nudges a run_commands call whose command is gone", async () => {
		writeSession([prompt, toolUse("run_commands", T0 - 9 * MIN, { commands: ["npm test"] })]);
		const harness = createHarness();
		expect(await harness.evaluate()).toMatchObject([{ answer: { kind: "nudge", cause: "silent_stall" } }]);
		expect(harness.delivered()[0]).toContain("Your last tool call (run_commands) didn't return");
	});

	it("leaves a pending question to the user alone", async () => {
		writeSession([prompt, toolUse("ask_followup_question", T0 - 30 * MIN, { question: "Which page?" })], {
			status: "idle",
		});
		const harness = createHarness();
		expect(await harness.evaluate()).toEqual([]);
		expect(harness.actions).toEqual([]);
	});

	it("counts a hook as progress", async () => {
		writeSession([prompt, toolUse("apply_patch", T0 - 9 * MIN)], { status: "idle" });
		const harness = createHarness();
		expect(await harness.evaluate({ ...running(), lastHookAt: T0 - 2 * MIN })).toEqual([]);
		advance(6 * MIN);
		expect(await harness.evaluate({ ...running(), lastHookAt: T0 - 2 * MIN })).toMatchObject([
			{ answer: { kind: "nudge" } },
		]);
	});

	it("only logs in report mode", async () => {
		writeSession([prompt, toolUse("apply_patch", T0 - 9 * MIN)], { status: "idle" });
		const harness = createHarness({});
		expect(await harness.evaluate()).toMatchObject([
			{ answer: { kind: "nudge", cause: "silent_stall" }, outcome: "report" },
		]);
		expect(harness.actions).toEqual([]);
	});
});
