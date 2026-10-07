import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

import { buildKanbanRuntimeUrl, getRuntimeFetch } from "../core/runtime-endpoint";
import type { RuntimeAppRouter } from "../trpc/app-router";

/** tRPC client for CLI commands that talk to the running Kanban server, scoped to a workspace when given. */
export function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					return runtimeFetch(url, options);
				},
			}),
		],
	});
}

export type RuntimeTrpcClient = ReturnType<typeof createRuntimeTrpcClient>;

/** Tells the server (if one is running) to re-read and broadcast a workspace's state after a CLI write. */
export async function notifyRuntimeWorkspaceStateUpdated(runtimeClient: RuntimeTrpcClient): Promise<void> {
	await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);
}
