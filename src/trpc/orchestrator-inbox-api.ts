// tRPC `orchestratorInbox.*` (src/server/orchestrator-inbox.ts): the orchestrator sidebar's prompt hook takes its
// workspace's silent wakes (`take`), and the sidebar panel shows how many wait (`status`). Both are workspace-scoped
// procedures, never on the project list. `take` empties the inbox, so it decides on the strict caller: only that
// workspace's orchestrator (its sidebar's hook, which sends the session credential) or the user; a card, another
// workspace's orchestrator or an unidentified caller would drain notices meant for someone else.
import { z } from "zod";

import { describeCaller, type RuntimeCaller } from "../isolation/session-identity";
import { formatOrchestratorNotices, type OrchestratorInboxReader } from "../state/orchestrator-inbox";

export const orchestratorInboxTakeResponseSchema = z.object({
	ok: z.boolean(),
	/** The framed notices for the prompt (Claude Code `additionalContext`), or null when there are none. */
	notices: z.string().nullable(),
	count: z.number().int().nonnegative(),
	error: z.string().optional(),
});
export type OrchestratorInboxTakeResponse = z.infer<typeof orchestratorInboxTakeResponseSchema>;

export const orchestratorInboxStatusResponseSchema = z.object({
	pending: z.number().int().nonnegative(),
	oldestAt: z.string().nullable(),
});
export type OrchestratorInboxStatusResponse = z.infer<typeof orchestratorInboxStatusResponseSchema>;

export interface RuntimeOrchestratorInboxApi {
	take: (input: { caller: RuntimeCaller; workspaceId: string }) => Promise<OrchestratorInboxTakeResponse>;
	status: (workspaceId: string) => Promise<OrchestratorInboxStatusResponse>;
}

/** Why the caller may not take the workspace's notices, or null. */
export function refuseOrchestratorInboxCaller(caller: RuntimeCaller, workspaceId: string): string | null {
	if (caller.kind === "user") {
		return null;
	}
	if (
		caller.kind === "session" &&
		caller.session.role === "orchestrator" &&
		caller.session.workspaceId === workspaceId
	) {
		return null;
	}
	return `${workspaceId}'s Kanban notices are taken only by its own orchestrator sidebar, not ${describeCaller(caller)}.`;
}

export function createOrchestratorInboxApi(deps: {
	inbox: OrchestratorInboxReader;
	log: (message: string) => void;
}): RuntimeOrchestratorInboxApi {
	return {
		take: async ({ caller, workspaceId }) => {
			const refused = refuseOrchestratorInboxCaller(caller, workspaceId);
			if (refused) {
				deps.log(`[orchestrator-inbox] ${workspaceId}: take refused: ${refused}`);
				return { ok: false, notices: null, count: 0, error: refused };
			}
			const entries = await deps.inbox.take(workspaceId);
			if (entries.length > 0) {
				deps.log(`[orchestrator-inbox] ${workspaceId}: ${entries.length} notice(s) handed to the sidebar's prompt`);
			}
			return { ok: true, notices: formatOrchestratorNotices(entries), count: entries.length };
		},
		status: async (workspaceId) => await deps.inbox.status(workspaceId),
	};
}
