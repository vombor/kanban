import type { Command } from "commander";
import { KANBAN_SESSION_WORKSPACE_ENV } from "../isolation/session-identity";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

export function registerCoordinationCommand(program: Command) {
	program
		.command("coordination")
		.description("Read-only coordination advice; never starts, reassigns, links or accepts work.")
		.option("--project <workspace>", "Workspace id or project path.")
		.option("--plan <task-id>", "Use the exact user-approved plan bundle.")
		.action(async (options: { project?: string; plan?: string }) => {
			try {
				const workspace = await resolveWorkspaceTarget(
					options.project ?? process.env[KANBAN_SESSION_WORKSPACE_ENV],
					{ allowUnregistered: false },
				);
				const result = await createRuntimeTrpcClient(workspace.workspaceId).coordination.preview.query({
					planTaskId: options.plan,
				});
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			} catch {
				process.stderr.write("Coordination unavailable in this project; no workflow action was performed.\n");
				process.exitCode = 1;
			}
		});
}
