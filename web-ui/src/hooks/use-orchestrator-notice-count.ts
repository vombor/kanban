import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useInterval } from "@/utils/react-use";

export const ORCHESTRATOR_NOTICE_POLL_MS = 15_000;

/**
 * How many Kanban notices wait silently for the project's orchestrator sidebar (src/server/orchestrator-inbox.ts):
 * watchdog wakes queued for the agent's next prompt while the user works there. Read from the workspace-scoped
 * `orchestratorInbox.status` (never the project list) every ORCHESTRATOR_NOTICE_POLL_MS; 0 when it can't be read.
 */
export function useOrchestratorNoticeCount(workspaceId: string | null): number {
	const [count, setCount] = useState(0);
	const requestRef = useRef(0);
	const refresh = useCallback(() => {
		const request = ++requestRef.current;
		if (!workspaceId) {
			setCount(0);
			return;
		}
		void (async () => {
			let pending = 0;
			try {
				pending = (await getRuntimeTrpcClient(workspaceId).orchestratorInbox.status.query()).pending;
			} catch {
				// an older server or a dropped connection: no badge
			}
			// A slower answer for a project the user has left doesn't overwrite the current one.
			if (request === requestRef.current) {
				setCount(pending);
			}
		})();
	}, [workspaceId]);
	useEffect(() => {
		refresh();
	}, [refresh]);
	useInterval(refresh, workspaceId ? ORCHESTRATOR_NOTICE_POLL_MS : null);
	return count;
}
