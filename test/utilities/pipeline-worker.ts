import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePipelineConfig } from "../../src/config/pipeline-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
import { loadKitCatalog } from "../../src/kits/resolve-kit";
import type { PipelineActionRequest, PipelineActionResult } from "../../src/pipeline/actions";
import type { ChecksResult, ChecksRunner } from "../../src/pipeline/checks";
import { createPipelineDecisionLog, type PipelineDecisionRecord } from "../../src/pipeline/decision-log";
import type { PipelineSessionView, PipelineWorkspaceSnapshot } from "../../src/pipeline/engine";
import {
	createPipelineEventBus,
	type PipelineEventBus,
	type PipelineEventMap,
	type PipelineEventName,
} from "../../src/pipeline/events";
import type { PipelineFeatureRegistry } from "../../src/pipeline/features";
import { createPipelineStateStore } from "../../src/pipeline/pipeline-state";
import { createQaGate, type QaSilentStallRead } from "../../src/pipeline/qa-gate";
import { type AppendQaLog, createQaLogAppender } from "../../src/pipeline/qa-log";
import type { QaPreviewController } from "../../src/pipeline/qa-preview";
import type { QaVerdictRead } from "../../src/pipeline/qa-verdict";
import type { AgentRunError } from "../../src/pipeline/recovery-detect";
import { createReworkStage } from "../../src/pipeline/rework";
import type { StageQaNotesInput } from "../../src/pipeline/rework-notes";
import type { StaleBase } from "../../src/pipeline/rework-text";
import type { SubmissionInspector } from "../../src/pipeline/submission-stage";
import { createPipelineWorker, type PipelineWorkerDependencies } from "../../src/pipeline/worker";
import type { PipelineFinishTaskRequest, PipelineWorkerMessage } from "../../src/pipeline/worker-protocol";
import type { ClineSessionSize } from "../../src/terminal/cline-session-files";
import { createTempDir } from "./temp-dir";

/** What the QA gate asked the server for, in order. */
export type QaGateHarnessAction =
	| PipelineActionRequest
	| ({ kind: "finishTask" } & PipelineFinishTaskRequest)
	| { kind: "deliverInput"; workspaceId: string; taskId: string; text: string };

export interface PipelineWorkerHarnessOptions {
	/** The raw config.json content; mutable through `setConfig`. */
	config?: unknown;
	/** Default: every card has work (and the submission stage does nothing else). */
	hasWork?: (card: RuntimeBoardCard) => boolean;
	/** Replaces the fake submission stage built from `hasWork`. */
	inspectSubmission?: SubmissionInspector;
	createChecks?: (onResult: (result: ChecksResult) => Promise<void>) => ChecksRunner;
	appendQaLog?: AppendQaLog;
	/** Legacy checks-state.json per workspace id, for the import. */
	legacyChecksState?: Record<string, unknown>;
	/** The check scripts a snapshot's package.json has, for the QA gate's checks wait. Default: none (no wait). */
	checkScripts?: (snapshot: string) => string[];
	/** The QA gate's snapshot commit of a card. Default: every card has the snapshot `snap-<id>`. */
	snapshot?: (taskId: string) => string | null;
	/** The server's answer to a QA gate action, a Done request or a nudge. Default: ok. */
	actionResult?: (action: QaGateHarnessAction) => PipelineActionResult;
	/** Epoch ms; mutable through `setNow`. */
	now?: number;
	/** Replaces `now`/`setNow` as the clock of the worker and its state store (e.g. `() => Date.now()` with fake timers). */
	clock?: () => number;
	/** Replaces the recovery stage (which otherwise reads Cline session files under the test's HOME). */
	createRecovery?: PipelineWorkerDependencies["createRecovery"];
	/** The rework stage's view of a card's worktree. Default: none (no QA notes staged, no stale base). */
	worktree?: (taskId: string) => string | null;
	staleBase?: (taskId: string) => StaleBase | null;
	/** The card's session size for the `/clear` thresholds. Default: unknown. */
	sessionSize?: (agentId: RuntimeAgentId) => ClineSessionSize | null;
	/** The agent's clear command. Default: "/clear" for every agent. */
	clearCommand?: (agentId: RuntimeAgentId) => string | null;
	/** preserveWork for an escalation to a model. Default: records the tag. */
	preserveWork?: (input: { workspacePath: string; taskId: string; tag: string }) => Promise<unknown>;
	/** The worker's feature registry (default: the team kit's features with the worker's own actions). */
	createFeatures?: (input: {
		bus: PipelineEventBus;
		appendQaLog: AppendQaLog;
		root: string;
	}) => PipelineFeatureRegistry;
}

/**
 * A pipeline worker on temp dirs: its state, decision log and the kit dir live in one temp root, its config is
 * an in-memory config.json, and every event it emits is recorded.
 */
export function createPipelineWorkerHarness(options: PipelineWorkerHarnessOptions = {}) {
	const temp = createTempDir("kanban-pipeline-");
	let now = options.now ?? Date.parse("2026-10-07T10:00:00.000Z");
	const clock = options.clock ?? (() => now);
	const actions: QaGateHarnessAction[] = [];
	const answer = (action: QaGateHarnessAction): PipelineActionResult => {
		actions.push(action);
		return options.actionResult?.(action) ?? { ok: true };
	};
	const previewCalls: Array<{ call: "ensure" | "stopIfIdle"; workspaceId: string; qaActive?: boolean }> = [];
	const verdicts = new Map<string, QaVerdictRead>();
	const runErrors = new Map<string, AgentRunError>();
	const silentStalls = new Map<string, QaSilentStallRead>();
	const stoppedScratch: string[][] = [];
	let uuidCount = 0;
	let siblingCount = 0;
	const preservedTags: string[] = [];
	const stagedNotes: StageQaNotesInput[] = [];
	let snapshotOf = (taskId: string): string | null => (options.snapshot ? options.snapshot(taskId) : `snap-${taskId}`);
	let rawConfig: unknown = options.config ?? {};
	const messages: PipelineWorkerMessage[] = [];
	const events: Array<{ name: PipelineEventName; event: PipelineEventMap[PipelineEventName] }> = [];
	const statePath = (workspaceId: string) => join(temp.path, "data", workspaceId, "pipeline-state.json");
	const logPath = (workspaceId: string) => join(temp.path, "data", workspaceId, "pipeline-decisions.jsonl");
	const qaLogPath = (workspaceId: string) => join(temp.path, "data", workspaceId, "qa-log.md");
	const legacyDir = join(temp.path, "legacy");
	const bus = createPipelineEventBus();
	const store = createPipelineStateStore({
		now: clock,
		getStatePath: statePath,
		getLegacyChecksStatePaths: (workspaceId) => [join(legacyDir, workspaceId, "checks-state.json")],
	});
	const appendQaLog = options.appendQaLog ?? createQaLogAppender(qaLogPath);
	const artifactsPath = (workspaceId: string) => join(temp.path, "data", workspaceId, "qa-artifacts");
	const preview: QaPreviewController = {
		ensure: async ({ workspaceId }) => {
			previewCalls.push({ call: "ensure", workspaceId });
		},
		stopIfIdle: async ({ workspaceId, qaActive }) => {
			previewCalls.push({ call: "stopIfIdle", workspaceId, qaActive });
		},
	};
	const qaGate = createQaGate({
		actions: { run: async (request) => answer(request) },
		deliverInput: async (input) => answer({ kind: "deliverInput", ...input }),
		finishTask: async (request) => {
			const result = answer({ kind: "finishTask", ...request });
			return {
				ok: result.ok,
				status: result.ok ? "trashed" : "failed",
				taskId: request.taskId,
				previousColumnId: "review",
				readyTaskIds: [],
				autoStartedTasks: [],
				worktreeDeleted: result.ok,
				...(result.ok ? {} : { error: result.error }),
			};
		},
		appendQaLog,
		store,
		bus,
		preview,
		readSnapshot: async (_repoPath, taskId) => snapshotOf(taskId),
		readCheckScripts: async (_repoPath, snapshot) => options.checkScripts?.(snapshot) ?? [],
		readVerdict: async (outboxDir) => verdicts.get(outboxDir) ?? { kind: "missing" },
		readRunError: async ({ card }) => runErrors.get(card.id) ?? null,
		readSilentStall: async ({ card }) => silentStalls.get(card.id) ?? null,
		stopScratchProcesses: async (dirs) => {
			stoppedScratch.push(dirs);
			return 0;
		},
		copyArtifacts: async () => {},
		getQaLogPath: qaLogPath,
		getArtifactsPath: artifactsPath,
		getKanbanHome: () => "~/.kanban",
		// QA card ids qa001, qa002, …
		randomUuid: () => {
			uuidCount += 1;
			return `qa${String(uuidCount).padStart(3, "0")}00-0000-0000-0000-000000000000`;
		},
		log: () => {},
	});
	const features = options.createFeatures?.({ bus, appendQaLog, root: temp.path });
	const reworkStage = createReworkStage({
		runoffGroups: features?.runoffGroups,
		actions: { run: async (request) => answer(request) },
		deliverInput: async (input) => answer({ kind: "deliverInput", ...input }),
		store,
		bus,
		appendQaLog,
		preserveWork:
			options.preserveWork ??
			(async ({ tag }) => {
				preservedTags.push(tag);
			}),
		readSnapshot: async (_repoPath, taskId) => snapshotOf(taskId),
		findWorktree: async (_workspacePath, taskId) => options.worktree?.(taskId) ?? null,
		stageQaNotes: async (input) => {
			stagedNotes.push(input);
			return `.qa/r${input.round}`;
		},
		readStaleBase: async ({ worktreePath }) => options.staleBase?.(worktreePath) ?? null,
		readSessionSize: async (agentId) => options.sessionSize?.(agentId) ?? null,
		getClearCommand: (agentId) => (options.clearCommand ? options.clearCommand(agentId) : "/clear"),
		getQaLogPath: qaLogPath,
		getArtifactsPath: artifactsPath,
		// Sibling card ids s0001, s0002, …
		randomUuid: () => {
			siblingCount += 1;
			return `s${String(siblingCount).padStart(4, "0")}0-0000-0000-0000-000000000000`;
		},
		log: () => {},
	});
	for (const name of ["verdictRecorded", "landed", "reworkSent", "escalated"] as const) {
		bus.on(name, (event) => {
			events.push({ name, event });
		});
	}
	const worker = createPipelineWorker({
		send: (message) => messages.push(message),
		readConfig: async () => parsePipelineConfig(rawConfig),
		loadCatalog: async () => await loadKitCatalog(join(temp.path, "kits")),
		store,
		decisionLog: createPipelineDecisionLog({ getLogPath: logPath }),
		bus,
		inspectSubmission:
			options.inspectSubmission ??
			(async (_context, { card }) => ({ hasWork: options.hasWork?.(card) ?? true, records: [] })),
		createChecks: options.createChecks,
		appendQaLog,
		loadAgentDefaultModels: async () => ({}),
		qaGate,
		createRecovery: options.createRecovery,
		reworkStage,
		features,
		now: clock,
	});

	const readDecisions = (workspaceId: string): PipelineDecisionRecord[] => {
		const path = logPath(workspaceId);
		if (!existsSync(path)) {
			return [];
		}
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as PipelineDecisionRecord);
	};

	return {
		worker,
		messages,
		events,
		root: temp.path,
		legacyDir,
		statePath,
		store,
		actions,
		previewCalls,
		stoppedScratch,
		preservedTags,
		stagedNotes,
		/** Changes the snapshot commit the QA gate and the rework stage read. */
		setSnapshot: (next: (taskId: string) => string | null) => {
			snapshotOf = next;
		},
		/** What the QA card's outbox (`<outboxRoot>/<qaTaskId>`) holds. */
		setVerdict: (outboxDir: string, read: QaVerdictRead) => {
			verdicts.set(outboxDir, read);
		},
		/** The QA card's last turn as its agent's own error (the QA gate's readRunError); null clears it. */
		setRunError: (taskId: string, error: AgentRunError | null) => {
			if (error) {
				runErrors.set(taskId, error);
			} else {
				runErrors.delete(taskId);
			}
		},
		/** The running QA card's silent Cline stall (the QA gate's readSilentStall); null clears it. */
		setSilentStall: (taskId: string, read: QaSilentStallRead | null) => {
			if (read) {
				silentStalls.set(taskId, read);
			} else {
				silentStalls.delete(taskId);
			}
		},
		setNow: (next: number) => {
			now = next;
		},
		logPath,
		qaLogPath,
		setConfig: (next: unknown) => {
			rawConfig = next;
		},
		readDecisions,
		/** A stage's card decisions (no "watching" records); default the QA gate's. */
		readCardDecisions: (workspaceId: string, stage: PipelineDecisionRecord["stage"] = "qa_gate") =>
			readDecisions(workspaceId).filter((record) => record.taskId !== null && record.stage === stage),
		send: async (snapshot: PipelineWorkspaceSnapshot) => {
			await worker.handle({ type: "snapshot", snapshot });
			await worker.idle();
		},
		cleanup: () => {
			worker.close();
			temp.cleanup();
		},
	};
}

export function createSnapshot(input: {
	workspaceId: string;
	board: RuntimeBoardData;
	selectedAgentId: RuntimeAgentId;
	sessions?: Array<Partial<RuntimeTaskSessionSummary> & Pick<PipelineSessionView, "live"> & { taskId: string }>;
}): PipelineWorkspaceSnapshot {
	return {
		workspaceId: input.workspaceId,
		workspacePath: `/repos/${input.workspaceId}`,
		board: input.board,
		selectedAgentId: input.selectedAgentId,
		sessions: (input.sessions ?? []).map(
			(session): PipelineSessionView => ({
				taskId: session.taskId,
				agentId: session.agentId ?? null,
				modelId: session.modelId ?? null,
				state: session.state ?? "awaiting_review",
				...(session.lastHookAt !== undefined ? { lastHookAt: session.lastHookAt } : {}),
				...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
				...(session.stateChangedAt !== undefined ? { stateChangedAt: session.stateChangedAt } : {}),
				...(session.workspacePath !== undefined ? { workspacePath: session.workspacePath } : {}),
				...(session.reviewReason !== undefined ? { reviewReason: session.reviewReason } : {}),
				...(session.live !== undefined ? { live: session.live } : {}),
			}),
		),
	};
}
