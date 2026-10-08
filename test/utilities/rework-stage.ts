import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePipelineSettings, parsePipelineConfig } from "../../src/config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardCard, RuntimeBoardColumnId } from "../../src/core/api-contract";
import type { OnFailAnswer, RoutingPolicy } from "../../src/kits/policy";
import type { PipelineActionRequest, PipelineActionResult } from "../../src/pipeline/actions";
import { createPipelineEventBus, type PipelineEventMap, type PipelineEventName } from "../../src/pipeline/events";
import type { PipelineRunoffGroups } from "../../src/pipeline/features";
import { createPipelineStateStore, type PipelineCardState } from "../../src/pipeline/pipeline-state";
import type { QaPassEntry, QaVerdictRecord } from "../../src/pipeline/qa-gate";
import { createQaLogAppender } from "../../src/pipeline/qa-log";
import { createReworkStage } from "../../src/pipeline/rework";
import type { PipelineFinishTaskRequest } from "../../src/pipeline/worker-protocol";
import type { ClineSessionSize } from "../../src/terminal/cline-session-files";
import { createSnapshot } from "./pipeline-worker";
import { createTempDir } from "./temp-dir";
import { createBoard } from "./workspace-state-store";

export const REWORK_T0 = Date.parse("2026-10-07T10:00:00.000Z");

/** What the rework stage asked the server for, in order. */
export type ReworkHarnessAction =
	| PipelineActionRequest
	| { kind: "deliverInput"; workspaceId: string; taskId: string; text: string }
	| ({ kind: "finishTask" } & PipelineFinishTaskRequest);

type OnFailInput = Parameters<RoutingPolicy["onFail"]>[0];

export interface ReworkHarnessOptions {
	/** The stub kit's onFail answer (default: rework, clearContext auto). */
	onFail?: (input: OnFailInput) => OnFailAnswer;
	/** Raw `pipeline` config section. */
	pipeline?: unknown;
	actionResult?: (action: ReworkHarnessAction) => PipelineActionResult;
	sessionSize?: ClineSessionSize | null;
	clearCommand?: string | null;
	worktree?: string | null;
	preserveWork?: (input: { workspacePath: string; taskId: string; tag: string }) => Promise<unknown>;
	/** The runoff groups a runoff answer records into (the runoffs feature's). Default: none, so runoffs escalate. */
	runoffGroups?: PipelineRunoffGroups;
}

/** The rework stage on its own: a temp pipeline state and QA log, a stub kit, a fake server. */
export function createReworkHarness(options: ReworkHarnessOptions = {}) {
	const temp = createTempDir("kanban-rework-");
	let now = REWORK_T0;
	let snapshotOf = (taskId: string): string | null => `snap-${taskId}`;
	const actions: ReworkHarnessAction[] = [];
	const onFailCalls: OnFailInput[] = [];
	const preservedTags: string[] = [];
	const events: Array<{ name: PipelineEventName; event: PipelineEventMap[PipelineEventName] }> = [];
	const answer = (action: ReworkHarnessAction): PipelineActionResult => {
		actions.push(action);
		return options.actionResult?.(action) ?? { ok: true };
	};
	const store = createPipelineStateStore({
		now: () => REWORK_T0 - 60 * 60_000,
		getStatePath: (workspaceId) => join(temp.path, "data", workspaceId, "pipeline-state.json"),
		getLegacyChecksStatePaths: () => [],
	});
	const qaLogPath = (workspaceId: string) => join(temp.path, "data", workspaceId, "qa-log.md");
	const bus = createPipelineEventBus();
	for (const name of ["reworkSent", "escalated"] as const) {
		bus.on(name, (event) => {
			events.push({ name, event });
		});
	}
	let siblingCount = 0;
	const stage = createReworkStage({
		actions: { run: async (request) => answer(request) },
		deliverInput: async (input) => answer({ kind: "deliverInput", ...input }),
		store,
		bus,
		appendQaLog: createQaLogAppender(qaLogPath),
		preserveWork:
			options.preserveWork ??
			(async ({ tag }) => {
				preservedTags.push(tag);
			}),
		readSnapshot: async (_repoPath, taskId) => snapshotOf(taskId),
		findWorktree: async () => (options.worktree === undefined ? "/worktrees/card" : options.worktree),
		stageQaNotes: async (input) => `.qa/r${input.round}`,
		readStaleBase: async () => null,
		readSessionSize: async () => options.sessionSize ?? null,
		getClearCommand: () => (options.clearCommand === undefined ? "/clear" : options.clearCommand),
		runoffGroups: options.runoffGroups,
		finishTask: async (request) => {
			const result = answer({ kind: "finishTask", ...request });
			return {
				ok: result.ok,
				status: result.ok ? "trashed" : "failed",
				taskId: request.taskId,
				previousColumnId: "backlog",
				readyTaskIds: [],
				autoStartedTasks: [],
				worktreeDeleted: false,
				...(result.ok ? {} : { error: result.error }),
			};
		},
		getQaLogPath: qaLogPath,
		getArtifactsPath: (workspaceId) => join(temp.path, "data", workspaceId, "qa-artifacts"),
		randomUuid: () => {
			siblingCount += 1;
			return `s${String(siblingCount).padStart(4, "0")}0-0000-0000-0000-000000000000`;
		},
		log: () => {},
	});
	const policy: RoutingPolicy = {
		devAssignment: () => null,
		qaPolicy: () => ({ kind: "none", reason: "stub" }),
		onFail: (input) => {
			onFailCalls.push(input);
			return options.onFail?.(input) ?? { action: "rework", clearContext: "auto" };
		},
		onPass: () => ({ action: "land" }),
	};
	const config = parsePipelineConfig({
		pipeline: options.pipeline ?? {},
		workspaces: { foo: { landing: { mode: "qa" } } },
	}).config;

	return {
		store,
		actions,
		onFailCalls,
		preservedTags,
		events,
		qaLogPath: qaLogPath("foo"),
		readQaLog: () => (existsSync(qaLogPath("foo")) ? readFileSync(qaLogPath("foo"), "utf8") : ""),
		setNow: (next: number) => {
			now = next;
		},
		setSnapshot: (next: (taskId: string) => string | null) => {
			snapshotOf = next;
		},
		/** Writes the dev card's pipeline-state entry. */
		seed: async (taskId: string, entry: PipelineCardState) => {
			await store.update("foo", (state) => {
				state.cards[taskId] = { ...(state.cards[taskId] ?? {}), ...entry };
				return state;
			});
		},
		entry: async (taskId: string) => (await store.load("foo")).cards[taskId],
		tick: async (
			columns: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>,
			sessions: Parameters<typeof createSnapshot>[0]["sessions"] = [],
			selectedAgentId: RuntimeAgentId = "claude",
		) =>
			await stage.tick({
				snapshot: createSnapshot({ workspaceId: "foo", board: createBoard(columns), selectedAgentId, sessions }),
				settings: getWorkspacePipelineSettings(config, "foo"),
				rework: config.pipeline.rework,
				kitName: "stub",
				policy,
				clineDataDir: null,
				recoveryNudgeCheckMs: config.pipeline.recovery.nudgeCheckSec * 1000,
				now,
			}),
		cleanup: () => temp.cleanup(),
	};
}

export function failVerdict(round: number, overrides: Partial<QaVerdictRecord> = {}): QaVerdictRecord {
	return {
		qaTaskId: `qa00${round}`,
		round,
		snapshot: "snap-d1111",
		verdict: "FAIL",
		blocking: [`blocker of round ${round}`],
		notes: "",
		scores: null,
		visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
		artifactsDir: null,
		at: REWORK_T0 - (10 - round) * 60_000,
		...overrides,
	};
}

export function conflictPass(round: number): { qaVerdicts: QaVerdictRecord[]; qaPass: QaPassEntry } {
	const verdict = failVerdict(round, { verdict: "PASS", blocking: [] });
	return {
		qaVerdicts: [verdict],
		qaPass: {
			qaTaskId: verdict.qaTaskId,
			snapshot: verdict.snapshot,
			at: verdict.at + 1000,
			action: "land",
			status: "blocked",
			error: "conflicts",
			landing: { decision: "conflict", baseRef: "main", files: ["src/cart.ts"] },
		},
	};
}
