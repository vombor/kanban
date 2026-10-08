import { join } from "node:path";
import { vi } from "vitest";

import { parsePipelineConfig } from "../../src/config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardData, RuntimeTaskInputDeliveryResponse } from "../../src/core/api-contract";
import { loadKitCatalog } from "../../src/kits/resolve-kit";
import type { PipelineSessionView, PipelineWorkspaceSnapshot } from "../../src/pipeline/engine";
import { createPipelineEventBus } from "../../src/pipeline/events";
import { createPipelineFeatureRegistry } from "../../src/pipeline/features";
import { createPipelineStateStore } from "../../src/pipeline/pipeline-state";
import type { WatchdogActionRequest, WatchdogActionResults } from "../../src/pipeline/watchdog/actions";
import type { PidUsage } from "../../src/pipeline/watchdog/pid-pressure";
import { createWatchdog } from "../../src/pipeline/watchdog/watchdog";
import { getPidPressureFlagPaths, getWatchdogWorkspacePaths } from "../../src/state/kanban-home";
import { createTempDir } from "./temp-dir";

export const WATCHDOG_NOW = Date.parse("2026-10-07T12:00:00.000Z");

export interface WatchdogHarnessOptions {
	config?: unknown;
	pidUsage?: PidUsage | null;
	headlessPid?: number;
	/** Per-kind answers; `deliverInput` defaults to delivered. */
	results?: Partial<{ [Kind in WatchdogActionRequest["kind"]]: WatchdogActionResults[Kind] }>;
	/** A process the agent started still running in a worktree (default: none; never the real /proc). */
	findRunningTool?: (worktreePath: string, agentPid: number | null) => Promise<string | null>;
}

export function deliveryResult(status: RuntimeTaskInputDeliveryResponse["status"]): RuntimeTaskInputDeliveryResponse {
	return {
		ok: status === "delivered" || status === "sent",
		status,
		evidence: status === "delivered" ? "output" : null,
		enterAttempts: 1,
		summary: null,
	};
}

/** A watchdog on a temp home: its files, a recorded action client, injected PID use, headless lock and clock. */
export function createWatchdogHarness(options: WatchdogHarnessOptions = {}) {
	const temp = createTempDir("kanban-watchdog-");
	const home = temp.path;
	let rawConfig: unknown = options.config ?? { watchdog: { mode: "on" } };
	let now = WATCHDOG_NOW;
	let pidUsage = options.pidUsage ?? null;
	let headlessPid = options.headlessPid ?? 0;
	const requests: WatchdogActionRequest[] = [];
	const results = { ...options.results };
	const startHeadlessRun = vi.fn(
		(_input: { workspaceId: string; agentId: RuntimeAgentId; env?: Record<string, string> }) => ({
			ok: true,
			pid: 4242,
		}),
	);
	const log = vi.fn((_message: string) => {});
	const watchdog = createWatchdog({
		actions: {
			request: async (request) => {
				requests.push(request);
				const kind = request.kind;
				const fallback: { [Kind in WatchdogActionRequest["kind"]]: WatchdogActionResults[Kind] } = {
					deliverInput: deliveryResult("delivered"),
					interrupt: { ok: true },
					startOrchestratorSession: { ok: true, taskId: "x" },
					pruneDone: { ok: true, summary: "prune-done: nothing" },
					sweepProcesses: { ok: true, supported: true, orphans: 1, terminated: 1, zombies: 7 },
					issueOrchestratorCredential: { ok: true, credential: "cred-headless" },
					bindOrchestratorCredential: { ok: true },
				};
				return (results[kind] ?? fallback[kind]) as never;
			},
		},
		readConfig: async () => parsePipelineConfig(rawConfig),
		loadCatalog: async () => await loadKitCatalog(join(home, "kits")),
		store: createPipelineStateStore({
			now: () => now,
			getStatePath: (workspaceId) => join(home, "data", workspaceId, "pipeline-state.json"),
			getLegacyChecksStatePaths: () => [],
		}),
		features: createPipelineFeatureRegistry({ bus: createPipelineEventBus() }),
		getPaths: (workspaceId) => getWatchdogWorkspacePaths(workspaceId, home),
		getPidFlagPaths: () => getPidPressureFlagPaths(home),
		readPidUsage: async () => pidUsage,
		headlessPid: async () => headlessPid,
		startHeadlessRun,
		probeModel: async () => false,
		findRunningTool: async (worktreePath, agentPid) => options.findRunningTool?.(worktreePath, agentPid) ?? null,
		isTrusted: async () => true,
		now: () => now,
		log,
	});
	return {
		home,
		watchdog,
		requests,
		results,
		startHeadlessRun,
		log,
		paths: (workspaceId: string) => getWatchdogWorkspacePaths(workspaceId, home),
		setConfig: (next: unknown) => {
			rawConfig = next;
		},
		setNow: (next: number) => {
			now = next;
		},
		setPidUsage: (next: PidUsage | null) => {
			pidUsage = next;
		},
		setHeadlessPid: (next: number) => {
			headlessPid = next;
		},
		observe: (input: {
			workspaceId: string;
			board: RuntimeBoardData;
			sessions?: PipelineSessionView[];
			selectedAgentId?: RuntimeAgentId;
			workspacePath?: string;
		}): PipelineWorkspaceSnapshot => {
			const snapshot: PipelineWorkspaceSnapshot = {
				workspaceId: input.workspaceId,
				workspacePath: input.workspacePath ?? `/projects/${input.workspaceId}`,
				board: input.board,
				sessions: input.sessions ?? [],
				selectedAgentId: input.selectedAgentId ?? "claude",
			};
			watchdog.observe(snapshot);
			return snapshot;
		},
		cleanup: temp.cleanup,
	};
}
