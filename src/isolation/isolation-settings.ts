// Project isolation's settings (`isolation.mode`, `workspaces.<id>.isolation`, src/config/pipeline-config.ts) and
// the decisions every reader shares: which mode a workspace is in, which mode governs a reach from one workspace into
// another (the stricter of the two), and whether a workspace takes orchestrator messages.
import {
	getWorkspacePipelineSettings,
	type IsolationMode,
	type PipelineConfig,
	parsePipelineConfig,
	readPipelineConfig,
} from "../config/pipeline-config";

const MODE_ORDER: Record<IsolationMode, number> = { off: 0, report: 1, enforce: 2 };

/** A workspace's isolation mode: its own `isolation.mode`, else the machine-wide one. */
export function resolveIsolationMode(config: PipelineConfig, workspaceId: string): IsolationMode {
	return getWorkspacePipelineSettings(config, workspaceId).isolation.mode ?? config.isolation.mode;
}

/** The stricter of two modes. */
export function stricterIsolationMode(left: IsolationMode, right: IsolationMode): IsolationMode {
	return MODE_ORDER[left] >= MODE_ORDER[right] ? left : right;
}

/**
 * The mode that governs a session of `fromWorkspaceId` reaching `toWorkspaceId`: the stricter of the two, so a
 * project that turned isolation on is protected from the sessions of one that didn't.
 */
export function resolveReachIsolationMode(
	config: PipelineConfig,
	fromWorkspaceId: string,
	toWorkspaceId: string,
): IsolationMode {
	return stricterIsolationMode(
		resolveIsolationMode(config, fromWorkspaceId),
		resolveIsolationMode(config, toWorkspaceId),
	);
}

/** Whether some workspace (or the machine-wide default) is in `enforce`. */
export function isAnyWorkspaceEnforced(config: PipelineConfig): boolean {
	return (
		config.isolation.mode === "enforce" ||
		Object.values(config.workspaces).some((workspace) => workspace.isolation.mode === "enforce")
	);
}

/** Whether a workspace's switch lets its orchestrator send and receive orchestrator messages. */
export function workspaceAllowsMessages(config: PipelineConfig, workspaceId: string): boolean {
	return getWorkspacePipelineSettings(config, workspaceId).isolation.messages === "allow";
}

/** config.json; one that can't be read is the defaults (isolation off, messages denied). */
export async function readIsolationConfig(): Promise<PipelineConfig> {
	return (await readPipelineConfig().catch(() => parsePipelineConfig({}))).config;
}
