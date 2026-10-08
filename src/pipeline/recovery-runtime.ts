// The recovery stage's real dependencies in the pipeline worker: Cline session files, git in task worktrees, model
// probes, the restart manifest and pipeline-state.json. Tests build the stage with fakes instead.
import { stat } from "node:fs/promises";

import { readPipelineConfig } from "../config/pipeline-config";
import { canProbeProvider, probeModel } from "../models/model-probe";
import { loadModelProbeDependencies } from "../models/model-probe-setup";
import { createAgentToolProcessFinder } from "../server/process-reaper";
import { getClineDataDirPath, getPipelineStatePath } from "../state/kanban-home";
import { createClineSessionFileReader, getClineSessionsPath } from "../terminal/cline-session-files";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import type { PipelineDecisionLog } from "./decision-log";
import { createPipelineStateStore, type PipelineStateStore } from "./pipeline-state";
import type { RecoveryFlowPatch } from "./recovery";
import { createRecoveryStage, type RecoveryStage, type RecoveryStageDependencies } from "./recovery-stage";
import { consumeRestartRecoveryRequest, readRestartManifest, removeRestartManifest } from "./restart-recovery";
import { hasTrackedChanges, tagRestartWip } from "./wip-tag";

// Gitignored report dirs a test run leaves behind; one of them overflowed a 131k context (0a3d1fc).
const GENERATED_REPORT_DIRS = ["playwright-report", "test-results", "coverage", "blob-report"];

/**
 * Removes the gitignored generated report dirs from a worktree (`git clean -X`: only ignored files, so nothing the
 * agent wrote on purpose is touched). Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597
 * (cleanGeneratedReports).
 */
export async function cleanGeneratedReports(worktreePath: string): Promise<string[]> {
	const present: string[] = [];
	for (const dir of GENERATED_REPORT_DIRS) {
		if (
			(
				await runGit(worktreePath, [
					"ls-files",
					"--others",
					"--ignored",
					"--exclude-standard",
					"--directory",
					"--",
					dir,
				])
			).stdout
		) {
			present.push(dir);
		}
	}
	if (present.length === 0) {
		return [];
	}
	const cleaned = await runGit(worktreePath, ["clean", "-fdXq", "--", ...present]);
	return cleaned.ok ? present : [];
}

/** Merges recovery patches into the cards' `qaflow` entries. */
export function applyRecoveryPatches(
	cards: Record<string, Record<string, unknown>>,
	patches: ReadonlyMap<string, RecoveryFlowPatch>,
): Record<string, Record<string, unknown>> {
	const next = { ...cards };
	for (const [taskId, patch] of patches) {
		const entry = next[taskId] ?? {};
		const qaflow =
			entry.qaflow && typeof entry.qaflow === "object" && !Array.isArray(entry.qaflow)
				? (entry.qaflow as Record<string, unknown>)
				: {};
		next[taskId] = { ...entry, qaflow: { ...qaflow, ...patch } };
	}
	return next;
}

export function createWorkerRecoveryStage(options: {
	store: PipelineStateStore;
	decisionLog: PipelineDecisionLog;
	act: RecoveryStageDependencies["act"];
	log: (message: string) => void;
	now?: () => number;
}): RecoveryStage {
	const reader = createClineSessionFileReader();
	const sessionsPath = async (): Promise<string> => {
		const { config } = await readPipelineConfig();
		return getClineSessionsPath(getClineDataDirPath(config.agents.cline.dataDir));
	};
	return createRecoveryStage({
		locateWorktree: async (workspacePath, card) => {
			try {
				const info = await getTaskWorkspacePathInfo({ cwd: workspacePath, taskId: card.id, baseRef: card.baseRef });
				return info.exists ? info.path : null;
			} catch {
				return null;
			}
		},
		readSessionDetail: async (worktreePath) =>
			await reader.readLatestSessionDetail(await sessionsPath(), worktreePath),
		findRunningTool: createAgentToolProcessFinder(),
		canProbe: canProbeProvider,
		probe: async (target) => {
			const { config } = await readPipelineConfig();
			const loaded = await loadModelProbeDependencies(config);
			const outcome = await probeModel(target, loaded.deps);
			const detail =
				outcome.kind === "tool-call"
					? `${outcome.result.status ?? "ERR"} ${outcome.result.detail}`
					: outcome.kind === "health"
						? outcome.detail
						: outcome.reason;
			return { up: outcome.up, detail };
		},
		act: options.act,
		cleanGeneratedReports,
		tagRestartWip: async (worktreePath, taskId) => await tagRestartWip(worktreePath, taskId),
		hasTrackedChanges,
		readManifest: readRestartManifest,
		removeManifest: removeRestartManifest,
		consumeRecoverRequest: consumeRestartRecoveryRequest,
		updateCards: async (workspaceId, patches) => {
			await options.store.update(workspaceId, (state) => ({
				...state,
				cards: applyRecoveryPatches(state.cards, patches),
			}));
		},
		appendRecords: async (records) => await options.decisionLog.append(records),
		sleep: async (ms) =>
			await new Promise((resolve) => {
				setTimeout(resolve, ms).unref();
			}),
		now: options.now ?? Date.now,
		log: options.log,
	});
}

/**
 * Rewrites one card's `qaflow` entry from a CLI command (`kanban task resume`, `restart-fresh`), only when the
 * workspace already has a pipeline-state.json: a workspace the pipeline never watched gets no state file from it.
 * Returns whether it wrote.
 */
export async function updateTrackedPipelineCardFlow(
	workspaceId: string,
	taskId: string,
	update: (qaflow: Record<string, unknown>) => Record<string, unknown>,
	options: { store?: PipelineStateStore; statePath?: string } = {},
): Promise<boolean> {
	const path = options.statePath ?? getPipelineStatePath(workspaceId);
	if (
		!(await stat(path).then(
			() => true,
			() => false,
		))
	) {
		return false;
	}
	const store = options.store ?? createPipelineStateStore();
	await store.update(workspaceId, (state) => {
		const entry = state.cards[taskId] ?? {};
		const qaflow =
			entry.qaflow && typeof entry.qaflow === "object" && !Array.isArray(entry.qaflow)
				? (entry.qaflow as Record<string, unknown>)
				: {};
		return { ...state, cards: { ...state.cards, [taskId]: { ...entry, qaflow: update({ ...qaflow }) } } };
	});
	return true;
}
