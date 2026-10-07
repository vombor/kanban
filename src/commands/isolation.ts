// `kanban isolation status|grant|approve|revoke|grants` (docs/fork/project-isolation.md). `status` shows who the
// caller is and each project's isolation mode and message switch. `grant` is the user's escape hatch for a rare
// cross-project task: one session of a project may reach named other projects for a while. It only works from the
// user's own terminal with the one-time code the server prints on its console (approvals.ts): the server refuses
// grants from agent sessions (their credential, or traced to their process tree), the CLI refuses the command inside
// one (src/isolation/cli-scope.ts), and the code covers what neither can see (a process reparented away from its
// session). Grants live in the server's memory only and are logged on both sides.
import type { Command } from "commander";

import { getWorkspacePipelineSettings } from "../config/pipeline-config";
import { completeIsolationApproval } from "../isolation/cli-approval";
import { ORCHESTRATOR_GRANT_SESSION } from "../isolation/grants";
import { readIsolationConfig, resolveIsolationMode } from "../isolation/isolation-settings";
import { listWorkspaceIndexEntries } from "../state/workspace-state";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseMinutes(value: string): number {
	const minutes = Number(value);
	if (!Number.isInteger(minutes) || minutes <= 0) {
		throw new Error(`Expected a whole number of minutes, got "${value}".`);
	}
	return minutes;
}

export function registerIsolationCommand(program: Command): void {
	const isolation = program
		.command("isolation")
		.description("Project isolation: who this caller is, each project's mode, and the user's cross-project grants.");

	isolation
		.command("status")
		.description("Who this caller is (the user or an agent session) and each visible project's isolation settings.")
		.action(async () => {
			try {
				const config = await readIsolationConfig();
				const whoami = await createRuntimeTrpcClient(null)
					.isolation.whoami.query()
					.catch(() => null);
				// Inside a session the listing is already scoped to what it may see (cli-scope.ts).
				const projects = (await listWorkspaceIndexEntries()).map((entry) => ({
					workspaceId: entry.workspaceId,
					repoPath: entry.repoPath,
					mode: resolveIsolationMode(config, entry.workspaceId),
					messages: getWorkspacePipelineSettings(config, entry.workspaceId).isolation.messages,
				}));
				print({ ok: true, caller: whoami ?? { caller: "unknown (runtime not reachable)" }, projects });
			} catch (error) {
				process.stderr.write(`Isolation status failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	isolation
		.command("grant")
		.description(
			"Let one session of a project reach other projects for a while (the user only, with the code from the Kanban server's console; logged on both sides, gone at the next Kanban restart).",
		)
		.requiredOption("--project <project>", "The session's project (workspace id or name).")
		.option(
			"--session <session>",
			`The session: a card's task id, or "${ORCHESTRATOR_GRANT_SESSION}" (default).`,
			ORCHESTRATOR_GRANT_SESSION,
		)
		.requiredOption("--reach <projects...>", "The projects it may reach (workspace ids or names).")
		.option("--minutes <minutes>", "How long the grant lasts (default 60, at most 1440).", parseMinutes, 60)
		.requiredOption("--reason <text>", "Why: written to both projects' isolation.jsonl.")
		.action(
			async (options: { project: string; session: string; reach: string[]; minutes: number; reason: string }) => {
				try {
					const client = createRuntimeTrpcClient(null);
					const result = await client.isolation.grant.mutate({
						project: options.project,
						session: options.session,
						reach: options.reach,
						minutes: options.minutes,
						reason: options.reason,
					});
					if (!result.approvalId) {
						print(result);
						process.exitCode = result.ok ? 0 : 1;
						return;
					}
					const outcome = await completeIsolationApproval({
						client,
						approvalId: result.approvalId,
						what: "The grant",
					});
					print(outcome.ok ? { ok: true, grantId: outcome.result } : outcome);
					if (!outcome.ok) {
						process.exitCode = 1;
					}
				} catch (error) {
					process.stderr.write(`Isolation grant failed (is Kanban running?): ${toErrorMessage(error)}\n`);
					process.exitCode = 1;
				}
			},
		);

	isolation
		.command("approve")
		.description(
			"Approve a pending grant or project change with the one-time code the Kanban server printed on its console (the user only).",
		)
		.argument("<approvalId>", "The approval id the waiting command printed.")
		.argument("<code>", "The code from the server's console.")
		.action(async (approvalId: string, code: string) => {
			try {
				const result = await createRuntimeTrpcClient(null).isolation.approve.mutate({ id: approvalId, code });
				print(result);
				if (!result.ok) {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`Isolation approve failed (is Kanban running?): ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	isolation
		.command("revoke")
		.description("End a grant early (the user only).")
		.argument("<grantId>", "The grant id (kanban isolation grants).")
		.action(async (grantId: string) => {
			try {
				const result = await createRuntimeTrpcClient(null).isolation.revoke.mutate({ id: grantId });
				print(result);
				if (!result.ok) {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`Isolation revoke failed (is Kanban running?): ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	isolation
		.command("grants")
		.description("The live grants (a session sees only its own project's).")
		.action(async () => {
			try {
				print(await createRuntimeTrpcClient(null).isolation.grants.query());
			} catch (error) {
				process.stderr.write(`Isolation grants failed (is Kanban running?): ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
