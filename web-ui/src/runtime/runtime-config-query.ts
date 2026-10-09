// Browser-side query helpers for runtime settings and Cline actions.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeProcessSweepResponse,
	RuntimeProjectShortcut,
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
} from "@/runtime/types";

export async function fetchRuntimeConfig(workspaceId: string | null): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getConfig.query();
}

export async function saveRuntimeConfig(
	workspaceId: string | null,
	nextConfig: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
	},
): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveConfig.mutate(nextConfig);
}

/**
 * A project's shortcuts change only through the shortcut route, which checks who asks (src/trpc/shortcuts-api.ts):
 * the settings dialog saves its whole list, the top bar's "add shortcut" adds one. Throws the route's refusal.
 */
export async function replaceProjectShortcuts(
	workspaceId: string,
	shortcuts: RuntimeProjectShortcut[],
): Promise<RuntimeProjectShortcut[]> {
	const response = await getRuntimeTrpcClient(workspaceId).shortcuts.replace.mutate({ shortcuts });
	if (!response.ok) {
		throw new Error(response.error ?? "the shortcuts were not saved");
	}
	return response.shortcuts;
}

export async function addProjectShortcut(
	workspaceId: string,
	shortcut: RuntimeProjectShortcut,
): Promise<RuntimeProjectShortcut[]> {
	const response = await getRuntimeTrpcClient(workspaceId).shortcuts.add.mutate({
		label: shortcut.label,
		command: shortcut.command,
		icon: shortcut.icon ?? null,
	});
	if (!response.ok) {
		throw new Error(response.error ?? "the shortcut was not saved");
	}
	return response.shortcuts;
}

export async function resetRuntimeDebugState(workspaceId: string | null): Promise<RuntimeDebugResetAllStateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.resetAllState.mutate();
}

export async function openFileOnHost(workspaceId: string | null, filePath: string): Promise<void> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	await trpcClient.runtime.openFile.mutate({ filePath });
}

export async function fetchRuntimeUpdateStatus(workspaceId: string | null): Promise<RuntimeUpdateStatusResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getUpdateStatus.query();
}

export async function runRuntimeUpdateNow(workspaceId: string | null): Promise<RuntimeRunUpdateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.runUpdateNow.mutate();
}

export async function fetchProcessSweep(): Promise<RuntimeProcessSweepResponse> {
	return await getRuntimeTrpcClient(null).runtime.getProcessSweep.query();
}

export async function runProcessSweepNow(): Promise<RuntimeProcessSweepResponse> {
	return await getRuntimeTrpcClient(null).runtime.runProcessSweep.mutate();
}
