// Loads what the shadow diff compares (shadow-diff.ts) for one workspace. Read-only: the legacy kit's autoland log,
// the pipeline's decision log (and its rotated `.1`), the kit's dev-assignment log, the workspace's board, and the
// workspace's resolved kit. Every path comes from src/state/kanban-home.ts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspacePipelineSettings, type PipelineConfig } from "../../config/pipeline-config";
import { loadGlobalRuntimeConfig } from "../../config/runtime-config";
import type { RuntimeAgentId, RuntimeBoardData } from "../../core/api-contract";
import { DEV_ASSIGNMENT_LOG_FILENAME, type DevAssignmentLogEntry } from "../../kits/dev-assignment";
import { createRoutingPolicy } from "../../kits/policy";
import { type KitCatalog, resolveWorkspaceKit } from "../../kits/resolve-kit";
import {
	getKanbanWorkspaceDataPath,
	getLegacyKitChecksStatePaths,
	getPipelineDecisionLogPath,
} from "../../state/kanban-home";
import { loadWorkspaceBoardById } from "../../state/workspace-state";
import type { PipelineDecisionRecord } from "../decision-log";
import type { LegacyAutolandLog } from "./legacy-autoland-log";
import type { ShadowDiffInput } from "./shadow-diff";

async function readTextIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

/** JSON lines that parse to objects; a torn last line (a writer mid-append) is skipped. */
export function parseJsonLines<T>(text: string | null): T[] {
	return (text ?? "").split("\n").flatMap((line) => {
		if (!line.trim()) {
			return [];
		}
		try {
			const value: unknown = JSON.parse(line);
			return value && typeof value === "object" && !Array.isArray(value) ? [value as T] : [];
		} catch {
			return [];
		}
	});
}

export async function readPipelineDecisions(workspaceId: string): Promise<PipelineDecisionRecord[]> {
	const path = getPipelineDecisionLogPath(workspaceId);
	const [rotated, current] = await Promise.all([readTextIfExists(`${path}.1`), readTextIfExists(path)]);
	return [...parseJsonLines<PipelineDecisionRecord>(rotated), ...parseJsonLines<PipelineDecisionRecord>(current)];
}

export async function readDevAssignments(workspaceId: string): Promise<DevAssignmentLogEntry[]> {
	return parseJsonLines<DevAssignmentLogEntry>(
		await readTextIfExists(join(getKanbanWorkspaceDataPath(workspaceId), DEV_ASSIGNMENT_LOG_FILENAME)),
	);
}

/** `qaflow.resetAt` per card from the legacy kit's checks-state.json (the first copy found; read-only). */
export async function readLegacyResets(workspaceId: string): Promise<Record<string, string>> {
	for (const path of getLegacyKitChecksStatePaths(workspaceId)) {
		const text = await readTextIfExists(path);
		if (text === null) {
			continue;
		}
		const resets: Record<string, string> = {};
		try {
			const state: unknown = JSON.parse(text);
			for (const [taskId, entry] of Object.entries(isRecord(state) ? state : {})) {
				const resetAt = isRecord(entry) && isRecord(entry.qaflow) ? entry.qaflow.resetAt : undefined;
				if (typeof resetAt === "string") {
					resets[taskId] = resetAt;
				}
			}
		} catch {
			return {};
		}
		return resets;
	}
	return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readBoard(workspaceId: string): Promise<RuntimeBoardData | null> {
	try {
		return await loadWorkspaceBoardById(workspaceId);
	} catch {
		return null;
	}
}

export interface LoadShadowDiffInputOptions {
	workspaceId: string;
	config: PipelineConfig;
	catalog: KitCatalog;
	legacy: LegacyAutolandLog;
	since: number;
	until: number;
	windowMs: number;
	selectedAgentId?: RuntimeAgentId;
}

export async function loadShadowDiffInput(
	options: LoadShadowDiffInputOptions,
): Promise<ShadowDiffInput & { issues: string[] }> {
	const resolved = resolveWorkspaceKit(options.config, options.workspaceId, options.catalog);
	const [decisions, devAssignments, board, legacyResets, selectedAgentId] = await Promise.all([
		readPipelineDecisions(options.workspaceId),
		readDevAssignments(options.workspaceId),
		readBoard(options.workspaceId),
		readLegacyResets(options.workspaceId),
		options.selectedAgentId ?? loadGlobalRuntimeConfig().then((runtimeConfig) => runtimeConfig.selectedAgentId),
	]);
	const settings = getWorkspacePipelineSettings(options.config, options.workspaceId);
	const issues = [...resolved.issues];
	if (!board) {
		issues.push(`the board of ${options.workspaceId} could not be read: QA card agents are not compared`);
	}
	if (settings.landing.mode !== "qa") {
		issues.push(`landing mode is ${settings.landing.mode}, not qa: the pipeline decides nothing for this workspace`);
	}
	return {
		workspaceId: options.workspaceId,
		since: options.since,
		until: options.until,
		windowMs: options.windowMs,
		legacy: options.legacy,
		decisions,
		devAssignments,
		board,
		selectedAgentId,
		kitName: resolved.kitName,
		policy: createRoutingPolicy(resolved.kit),
		maxFailRounds: options.config.pipeline.rework.maxFailRounds,
		legacyResets,
		issues,
	};
}
