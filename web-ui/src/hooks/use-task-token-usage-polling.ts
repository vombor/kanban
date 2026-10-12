import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { setTaskTokenUsage } from "@/stores/task-token-usage-store";
import { useInterval } from "@/utils/react-use";

/** Session files change every few seconds while a card runs; a board's counts needn't follow faster than this. */
export const TASK_TOKEN_USAGE_POLL_MS = 20_000;

/**
 * Keeps the board cards' token counts (task-token-usage-store) current for the shown project: at once on a project
 * switch or when the tab comes back, then every TASK_TOKEN_USAGE_POLL_MS while the tab is visible. A failed read (an
 * older runtime) keeps the last counts.
 */
export function useTaskTokenUsagePolling(workspaceId: string | null, isDocumentVisible: boolean): void {
	const workspaceIdRef = useRef(workspaceId);
	workspaceIdRef.current = workspaceId;

	const refresh = useCallback(async () => {
		const requestedWorkspaceId = workspaceIdRef.current;
		if (!requestedWorkspaceId) {
			return;
		}
		try {
			const response = await getRuntimeTrpcClient(requestedWorkspaceId).workspace.getTaskTokenUsage.query();
			if (workspaceIdRef.current === requestedWorkspaceId) {
				setTaskTokenUsage(response.usage);
			}
		} catch {
			// Keep the last counts.
		}
	}, []);

	useEffect(() => {
		setTaskTokenUsage([]);
	}, [workspaceId]);

	useEffect(() => {
		if (workspaceId && isDocumentVisible) {
			void refresh();
		}
	}, [isDocumentVisible, refresh, workspaceId]);

	useInterval(
		() => {
			void refresh();
		},
		workspaceId && isDocumentVisible ? TASK_TOKEN_USAGE_POLL_MS : null,
	);
}
