import { useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useAsync } from "@/utils/react-use";

/** Pages replace each other. Navigating history never replays it into the live terminal or accumulates text buffers. */
export function useTerminalOutputHistory(workspaceId: string, taskId: string, open: boolean) {
	const [end, setEnd] = useState<number | null>(null);
	const [newer, setNewer] = useState<Array<number | null>>([]);
	const [refresh, setRefresh] = useState(0);
	const state = useAsync(async () => {
		if (!open) return null;
		return await getRuntimeTrpcClient(workspaceId).workspace.getTerminalHistory.query({ taskId, end });
	}, [workspaceId, taskId, open, end, refresh]);
	return {
		...state,
		canGoNewer: newer.length > 0,
		newest: () => {
			setEnd(null);
			setNewer([]);
			setRefresh((value) => value + 1);
		},
		older: () => {
			if (!state.value?.start || state.loading) return;
			setNewer((values) => [...values.slice(-19), end]);
			setEnd(state.value.start);
		},
		newer: () => {
			if (!newer.length || state.loading) return;
			setEnd(newer[newer.length - 1] ?? null);
			setNewer((values) => values.slice(0, -1));
		},
	};
}
