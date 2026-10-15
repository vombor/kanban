import { TRPCError } from "@trpc/server";
import type { RuntimeProjectSecretsApi } from "../trpc/project-secrets-contract";
import { createProjectSecretVault, type ProjectSecretVault } from "./project-secret-vault";

export function createProjectSecretsApi(
	vault: ProjectSecretVault = createProjectSecretVault(),
): RuntimeProjectSecretsApi {
	const assertUser = (caller: Parameters<RuntimeProjectSecretsApi["set"]>[0]["caller"]) => {
		if (caller.kind !== "user")
			throw new TRPCError({ code: "FORBIDDEN", message: "Project secrets are configured only by the user." });
	};
	return {
		list: async (input) => {
			if (
				input.caller.kind !== "user" &&
				!(input.caller.kind === "session" && input.caller.session.workspaceId === input.workspaceId)
			)
				throw new TRPCError({ code: "FORBIDDEN", message: "Project secret metadata belongs to that project." });
			return { secrets: await vault.list(input.workspaceId) };
		},
		set: async (input) => {
			assertUser(input.caller);
			return { secrets: await vault.set(input.workspaceId, input.secrets) };
		},
		remove: async (input) => {
			assertUser(input.caller);
			return { secrets: await vault.remove(input.workspaceId, input.name) };
		},
	};
}
