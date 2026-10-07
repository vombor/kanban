// `kanban board prune-done|restore`: board housekeeping and recovery. prune-done is the watchdog's hourly job run by
// hand (src/pipeline/watchdog/prune-done.ts); restore puts a saved board back after Kanban wiped a workspace
// (src/state/board-restore.ts).
import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { pruneDoneCards } from "../pipeline/watchdog/prune-done";
import { restoreBoardFromBackup } from "../state/board-restore";
import { createRuntimeTrpcClient, notifyRuntimeWorkspaceStateUpdated } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function parsePositiveNumber(value: string): number {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) {
		throw new Error(`Expected a positive number, got "${value}".`);
	}
	return number;
}

export function registerBoardCommand(program: Command): void {
	const board = program
		.command("board")
		.description("Board housekeeping: prune old Done cards, restore a wiped board.");

	board
		.command("prune-done")
		.description(
			"Delete Done cards older than --days after a backup (backups/boards/<workspace>/prune-done-<time>/). Keeps undecided runoffs and running calibrations.",
		)
		.option("--workspace <workspace>", "Workspace id or project path (default: the current project).")
		.option("--days <days>", "Age in days (default: watchdog.pruneDone.days).", parsePositiveNumber)
		.option("--dry-run", "List what would be deleted.")
		.action(async (options: { workspace?: string; days?: number; dryRun?: boolean }) => {
			try {
				const target = await resolveWorkspaceTarget(options.workspace, { allowUnregistered: false });
				if (!target.repoPath) {
					throw new Error(`Workspace ${target.workspaceId} has no project path.`);
				}
				const days = options.days ?? (await readPipelineConfig()).config.watchdog.pruneDone.days;
				const result = await pruneDoneCards({
					workspaceId: target.workspaceId,
					repoPath: target.repoPath,
					days,
					dryRun: options.dryRun === true,
				});
				if (result.backupPath) {
					await notifyRuntimeWorkspaceStateUpdated(createRuntimeTrpcClient(target.workspaceId));
				}
				process.stdout.write(
					`${JSON.stringify({ ok: true, workspaceId: target.workspaceId, ...result }, null, 2)}\n`,
				);
			} catch (error) {
				process.stderr.write(`Board prune-done failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	board
		.command("restore")
		.description(
			"Restore a workspace's board from a backup (default: the newest board-latest.json). Refuses unless the workspace's state dir is empty or missing; reload Kanban in the browser afterwards.",
		)
		.argument("<workspaceId>", "The workspace id.")
		.argument("[backup]", "The board JSON to restore.")
		.action(async (workspaceId: string, backup: string | undefined) => {
			try {
				const result = await restoreBoardFromBackup({ workspaceId, backupPath: backup });
				process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
				process.stderr.write("Restored. Reload Kanban in the browser.\n");
			} catch (error) {
				process.stderr.write(`Board restore failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
