import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

import { buildKanbanRuntimeUrl, getRuntimeFetch } from "../core/runtime-endpoint";
import { KANBAN_SESSION_CREDENTIAL_ENV, KANBAN_SESSION_CREDENTIAL_HEADER } from "../isolation/session-identity";
import type { RuntimeAppRouter } from "../trpc/app-router";

/**
 * The headers of a CLI runtime call: the workspace when given, and, inside an agent session, its credential
 * (src/isolation/session-identity.ts), so the server knows which session calls (it checks the calling process itself). The hook commands
 * (src/commands/hooks.ts) use their own client without them: Cline runs hooks in its shared daemon with another
 * card's env.
 */
export function buildRuntimeRequestHeaders(
	workspaceId: string | null,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const headers: Record<string, string> = workspaceId ? { "x-kanban-workspace-id": workspaceId } : {};
	const credential = env[KANBAN_SESSION_CREDENTIAL_ENV]?.trim();
	if (credential) {
		headers[KANBAN_SESSION_CREDENTIAL_HEADER] = credential;
	}
	return headers;
}

/** tRPC client for CLI commands that talk to the running Kanban server, scoped to a workspace when given. */
export function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => buildRuntimeRequestHeaders(workspaceId),
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
