import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { KANBAN_SESSION_WORKSPACE_ENV } from "../isolation/session-identity";
import { createRuntimeTrpcClient, type RuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";
export function registerIntegrationCommand(program: Command) {
	const command = program
		.command("integration")
		.description("Exact-candidate speculative reports, never per-card QA or landing approval.");
	const call = async (options: { project?: string }, operation: (client: RuntimeTrpcClient) => Promise<unknown>) => {
		try {
			const target = await resolveWorkspaceTarget(options.project ?? process.env[KANBAN_SESSION_WORKSPACE_ENV], {
				allowUnregistered: false,
			});
			process.stdout.write(
				`${JSON.stringify(await operation(createRuntimeTrpcClient(target.workspaceId)), null, 2)}\n`,
			);
		} catch {
			process.stderr.write(
				"Integration request unavailable or unconfirmed. Read retained history; never automatically replay code execution.\n",
			);
			process.exitCode = 1;
		}
	};
	command
		.command("preview <task-ids...>")
		.option("--project <workspace>")
		.option("--plan <task-id>")
		.action(async (taskIds: string[], options: { project?: string; plan?: string }) =>
			call(options, (client) => client.integration.preview.query({ taskIds, planTaskId: options.plan })),
		);
	command
		.command("run <task-ids...>")
		.description("User only: explicitly execute the reviewed candidate using the existing shared checks queue.")
		.option("--project <workspace>")
		.option("--plan <task-id>")
		.requiredOption("--fingerprint <sha256>", "Exact fingerprint returned by preview.")
		.option("--request-id <uuid>", "Retain this id after uncertain delivery; no automatic retries.")
		.action(
			async (
				taskIds: string[],
				options: { project?: string; plan?: string; fingerprint: string; requestId?: string },
			) => {
				const requestId = options.requestId ?? randomUUID();
				process.stderr.write(
					`Integration request id: ${requestId}. Retain it even if submission cannot be confirmed.\n`,
				);
				await call(options, (client) =>
					client.integration.run.mutate({
						taskIds,
						planTaskId: options.plan,
						fingerprint: options.fingerprint,
						requestId,
					}),
				);
			},
		);
	command
		.command("read <id>")
		.option("--project <workspace>")
		.action(async (id: string, options: { project?: string }) =>
			call(options, (client) => client.integration.read.query({ id })),
		);
	command
		.command("list")
		.option("--project <workspace>")
		.action(async (options: { project?: string }) =>
			call(options, (client) => client.integration.list.query({ offset: 0 })),
		);
}
