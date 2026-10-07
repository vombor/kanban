// The user's escape hatch (docs/fork/project-isolation.md): a grant lets one session of a workspace reach named other
// workspaces for a while. Grants live only in the server's memory: no file an agent could write holds them, and a
// restart drops them. They are made over tRPC `isolation.grant`, which refuses every agent session (the credential
// and the process-tree check, src/trpc/isolation-api.ts), so only the user's own shell (`kanban isolation grant`) or
// the browser makes one. Every grant, use and revoke is logged on both sides (isolation-log.ts).
import { randomBytes } from "node:crypto";

import type { AgentSessionIdentity } from "./session-identity";

/** `orchestrator` stands for the workspace's orchestrator session, whichever agent runs it. */
export const ORCHESTRATOR_GRANT_SESSION = "orchestrator";

export interface IsolationGrant {
	id: string;
	workspaceId: string;
	/** A task id, or `orchestrator`. */
	session: string;
	/** The workspaces the session may reach. */
	reach: string[];
	reason: string;
	createdAt: string;
	expiresAt: string;
}

export interface IsolationGrantStore {
	add: (input: Omit<IsolationGrant, "id" | "createdAt" | "expiresAt"> & { minutes: number }) => IsolationGrant;
	revoke: (id: string) => IsolationGrant | null;
	/** The live grants (expired ones are dropped). */
	list: () => IsolationGrant[];
	/** The live grant that lets the session reach the workspace, or null. */
	find: (session: AgentSessionIdentity, toWorkspaceId: string) => IsolationGrant | null;
}

export const MAX_GRANT_MINUTES = 24 * 60;

export function grantCoversSession(grant: IsolationGrant, session: AgentSessionIdentity): boolean {
	return (
		grant.workspaceId === session.workspaceId &&
		(grant.session === session.taskId ||
			(grant.session === ORCHESTRATOR_GRANT_SESSION && session.role === "orchestrator"))
	);
}

export function createIsolationGrantStore(now: () => number = Date.now): IsolationGrantStore {
	const grants = new Map<string, IsolationGrant>();
	const prune = () => {
		for (const [id, grant] of grants) {
			if (Date.parse(grant.expiresAt) <= now()) {
				grants.delete(id);
			}
		}
	};
	return {
		add: (input) => {
			const minutes = Math.min(Math.max(input.minutes, 1), MAX_GRANT_MINUTES);
			const grant: IsolationGrant = {
				id: `g-${randomBytes(4).toString("hex")}`,
				workspaceId: input.workspaceId,
				session: input.session,
				reach: [...new Set(input.reach)],
				reason: input.reason,
				createdAt: new Date(now()).toISOString(),
				expiresAt: new Date(now() + minutes * 60_000).toISOString(),
			};
			grants.set(grant.id, grant);
			return { ...grant, reach: [...grant.reach] };
		},
		revoke: (id) => {
			const grant = grants.get(id) ?? null;
			grants.delete(id);
			return grant;
		},
		list: () => {
			prune();
			return [...grants.values()].map((grant) => ({ ...grant, reach: [...grant.reach] }));
		},
		find: (session, toWorkspaceId) => {
			prune();
			for (const grant of grants.values()) {
				if (grantCoversSession(grant, session) && grant.reach.includes(toWorkspaceId)) {
					return { ...grant, reach: [...grant.reach] };
				}
			}
			return null;
		},
	};
}
