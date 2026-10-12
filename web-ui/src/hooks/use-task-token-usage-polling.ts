import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { setTaskTokenUsage } from "@/stores/task-token-usage-store";
import { useInterval } from "@/utils/react-use";

/**
 * Running cards' counts arrive live over the state stream (`task_token_usage_updated`); this slow re-read only catches
 * what a dropped stream missed.
 */
export const TASK_TOKEN_USAGE_POLL_MS = 60_000;

/**
 * Loads the board cards' token counts (task-token-usage-store) for the shown project: at once on a project switch or
 * when the tab comes back, then every TASK_TOKEN_USAGE_POLL_MS while the tab is visible; the runtime pushes the
 * changes in between. A failed read (an older runtime) keeps the last counts.
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
