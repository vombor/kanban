// The runtime side of explicit instance setup (USER_INSTANCE_COMMANDS in src/isolation/cli-scope.ts):
// the CLI asks here before it writes a model provider's settings into Cline's files (and before `kanban restart
// update`, whose own route checks again, src/trpc/restart-update-api.ts), so the server decides who calls
// with the strict caller lookup (a session without its credential is traced to its process tree), in every isolation
// mode, off included. The rule is cli-scope.ts's decideUserInstanceCaller: only the user is allowed; every orchestrator,
// any card and an unidentified caller are refused (and logged). The write itself stays in the CLI, which reads the key from its env.
import { z } from "zod";

import { decideUserInstanceCaller, USER_INSTANCE_COMMANDS } from "../isolation/cli-scope";
import type { IsolationService } from "../isolation/isolation-service";
import type { RuntimeCaller } from "../isolation/session-identity";

/** Which command asks; an older CLI sends nothing (setup-provider). */
export const providerSetupAuthorizeRequestSchema = z
	.object({ command: z.enum(USER_INSTANCE_COMMANDS).optional() })
	.optional();

export const providerSetupAuthorizeResponseSchema = z.object({
	allowed: z.boolean(),
	message: z.string().nullable(),
});
export type ProviderSetupAuthorizeResponse = z.infer<typeof providerSetupAuthorizeResponseSchema>;

export interface RuntimeProviderSetupApi {
	authorize: (caller: RuntimeCaller, command?: string) => Promise<ProviderSetupAuthorizeResponse>;
}

export interface CreateProviderSetupApiDependencies {
	log: IsolationService["log"];
}

export function createProviderSetupApi(deps: CreateProviderSetupApiDependencies): RuntimeProviderSetupApi {
	return {
		authorize: async (caller, command = "setup-provider") => {
			const decision = decideUserInstanceCaller(caller, command);
			if (decision.allowed) {
				return { allowed: true, message: null };
			}
			const fromWorkspaceId = caller.kind === "session" ? caller.session.workspaceId : null;
			await deps.log([fromWorkspaceId], {
				kind: "refused",
				taskId: caller.kind === "session" ? caller.session.taskId : null,
				from: fromWorkspaceId,
				to: null,
				action: "providers.authorizeSetup",
				detail: `${command} is the user's (${caller.kind === "session" ? `${caller.session.role} via ${caller.via}` : caller.kind === "unknown" ? caller.reason : "user"})`,
			});
			return { allowed: false, message: decision.message };
		},
	};
}
