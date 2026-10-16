import { TRPCError } from "@trpc/server";
import type { RuntimeCaller } from "../isolation/session-identity";
import type { KnowledgeActor, RuntimeKnowledgeApi } from "../trpc/knowledge-contract";
import { KnowledgeError } from "./knowledge-error";
import { createKnowledgeReader } from "./knowledge-reader";
import { createProjectKnowledgeStore, type ProjectKnowledgeStore } from "./knowledge-store";

/** Grants/isolation-off do not widen private knowledge. Scope is always the caller's own project or the user. */
export function authorizeKnowledgeCaller(caller: RuntimeCaller, workspaceId: string): KnowledgeActor {
	if (caller.kind === "user") return { kind: "user" };
	if (caller.kind === "session" && caller.session.workspaceId === workspaceId)
		return { kind: "session", role: caller.session.role, taskId: caller.session.taskId };
	throw new TRPCError({
		code: "FORBIDDEN",
		message: "Project knowledge is available only to the user and that project's identified sessions.",
	});
}
export function createKnowledgeApi(store: ProjectKnowledgeStore = createProjectKnowledgeStore()): RuntimeKnowledgeApi {
	const reader = createKnowledgeReader(store);
	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof KnowledgeError) throw new TRPCError({ code: error.code, message: error.message });
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Project knowledge could not be read or changed; check the storage and restore damaged data before retrying.",
			});
		}
	};
	return {
		list: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await reader.list(workspaceId, input));
		},
		read: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await reader.read(workspaceId, input));
		},
		search: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await reader.search(workspaceId, input));
		},
		context: async (caller, workspaceId) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await reader.context(workspaceId, undefined));
		},
		proposals: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await reader.proposals(workspaceId, input));
		},
		proposalRead: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await reader.proposalRead(workspaceId, input));
		},
		history: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await reader.history(workspaceId, input));
		},
		mutate: async (caller, workspaceId, input) => {
			const actor = authorizeKnowledgeCaller(caller, workspaceId);
			return await run(async () => await store.mutate(workspaceId, actor, input));
		},
	};
}
