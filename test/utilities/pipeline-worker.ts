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
import { createPipelineDecisionLog, type PipelineDecisionRecord } from "../../src/pipeline/decision-log";
import type { PipelineSessionView, PipelineWorkspaceSnapshot } from "../../src/pipeline/engine";
import { createPipelineEventBus, type PipelineEventMap, type PipelineEventName } from "../../src/pipeline/events";
import { createPipelineStateStore } from "../../src/pipeline/pipeline-state";
import { createPipelineWorker } from "../../src/pipeline/worker";
import type { PipelineWorkerMessage } from "../../src/pipeline/worker-protocol";
import { createTempDir } from "./temp-dir";

export interface PipelineWorkerHarnessOptions {
	/** The raw config.json content; mutable through `setConfig`. */
	config?: unknown;
	/** Default: every card has work. */
	hasWork?: (card: RuntimeBoardCard) => boolean;
	/** Legacy checks-state.json per workspace id, for the import. */
	legacyChecksState?: Record<string, unknown>;
}

/**
 * A pipeline worker on temp dirs: its state, decision log and the kit dir live in one temp root, its config is
 * an in-memory config.json, and every event it emits is recorded.
 */
export function createPipelineWorkerHarness(options: PipelineWorkerHarnessOptions = {}) {
	const temp = createTempDir("kanban-pipeline-");
	let rawConfig: unknown = options.config ?? {};
	const messages: PipelineWorkerMessage[] = [];
	const events: Array<{ name: PipelineEventName; event: PipelineEventMap[PipelineEventName] }> = [];
	const statePath = (workspaceId: string) => join(temp.path, "data", workspaceId, "pipeline-state.json");
	const logPath = (workspaceId: string) => join(temp.path, "data", workspaceId, "pipeline-decisions.jsonl");
	const legacyDir = join(temp.path, "legacy");
	const bus = createPipelineEventBus();
	for (const name of ["verdictRecorded", "landed", "reworkSent", "escalated"] as const) {
		bus.on(name, (event) => {
			events.push({ name, event });
		});
	}
	const worker = createPipelineWorker({
		send: (message) => messages.push(message),
		readConfig: async () => parsePipelineConfig(rawConfig),
		loadCatalog: async () => await loadKitCatalog(join(temp.path, "kits")),
		store: createPipelineStateStore({
			now: () => Date.parse("2026-10-07T10:00:00.000Z"),
			getStatePath: statePath,
			getLegacyChecksStatePaths: (workspaceId) => [join(legacyDir, workspaceId, "checks-state.json")],
		}),
		decisionLog: createPipelineDecisionLog({ getLogPath: logPath }),
		bus,
		hasWork: async (_workspacePath, card) => options.hasWork?.(card) ?? true,
		loadAgentDefaultModels: async () => ({}),
		now: () => Date.parse("2026-10-07T10:00:00.000Z"),
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
		logPath,
		setConfig: (next: unknown) => {
			rawConfig = next;
		},
		readDecisions,
		/** Card decisions only (no "watching" records). */
		readCardDecisions: (workspaceId: string) => readDecisions(workspaceId).filter((record) => record.taskId !== null),
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
	sessions?: Array<Partial<RuntimeTaskSessionSummary> & { taskId: string }>;
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
			}),
		),
	};
}
