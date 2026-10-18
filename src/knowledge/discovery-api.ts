import { TRPCError } from "@trpc/server";
import type { RuntimeKnowledgeDiscoveryApi } from "../trpc/knowledge-discovery-contract";
import type { createDiscoveryBroker } from "./discovery-broker";
import { authorizeKnowledgeCaller } from "./knowledge-api";
import { KnowledgeError } from "./knowledge-error";

export function createKnowledgeDiscoveryApi(
	broker: ReturnType<typeof createDiscoveryBroker>,
): RuntimeKnowledgeDiscoveryApi {
	const run = async <T>(operation: () => Promise<T>) => {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof KnowledgeError) throw new TRPCError({ code: error.code, message: error.message });
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Scoped reference discovery is unavailable; no credentials, upstream error or private fallback was exposed.",
			});
		}
	};
	const user = (caller: Parameters<RuntimeKnowledgeDiscoveryApi["policy"]>[0], workspaceId: string) => {
		authorizeKnowledgeCaller(caller, workspaceId);
		if (caller.kind !== "user")
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Only the user controls Shared collection definitions and project opt-ins.",
			});
	};
	return {
		policy: async (caller, workspaceId) => {
			user(caller, workspaceId);
			return run(() => broker.policy.view(workspaceId));
		},
		savePolicy: async (caller, workspaceId, input) => {
			user(caller, workspaceId);
			return run(() => broker.policy.saveProject(workspaceId, input));
		},
		saveCollection: async (caller, workspaceId, input) => {
			user(caller, workspaceId);
			return run(() => broker.policy.addCollection(workspaceId, input));
		},
		query: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return run(() => broker.query(workspaceId, input));
		},
		read: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return run(() => broker.read(workspaceId, input));
		},
		graph: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			return run(() => broker.graph(workspaceId, input));
		},
	};
}
