import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { isPipelineWorkspace } from "../pipeline/engine";
import { formatLegacyImportReport, runLegacyImport } from "../pipeline/legacy-import";
import { runPipelineWorkerProcess } from "../pipeline/worker";
import { getPipelineDecisionLogPath } from "../state/kanban-home";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById } from "../state/workspace-state";
import type { PipelinePauseResponse } from "../trpc/pipeline-pause-api";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

async function readLastDecisions(workspaceId: string, count: number): Promise<unknown[]> {
	if (count <= 0) {
		return [];
	}
	let text: string;
	try {
		text = await readFile(getPipelineDecisionLogPath(workspaceId), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line.trim())
		.slice(-count)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as unknown];
			} catch {
				return [];
			}
		});
}

/**
 * `pipeline pause|resume` go through the running server, which decides who is asking (the user, the project's own
 * orchestrator; src/trpc/pipeline-pause-api.ts) and tells the worker at once.
 */
async function setWorkspacePause(options: { workspace?: string; reason?: string }, paused: boolean): Promise<void> {
	const label = paused ? "Pipeline pause" : "Pipeline resume";
	try {
		const target = await resolveWorkspaceTarget(options.workspace, { allowUnregistered: false });
		let response: PipelinePauseResponse;
		try {
			response = await createRuntimeTrpcClient(target.workspaceId).pipeline.setPaused.mutate({
				paused,
				...(options.reason ? { reason: options.reason } : {}),
			});
		} catch (error) {
			throw new Error(
				`the running Kanban server didn't answer (${toErrorMessage(error)}); a pause changes only through it, because it checks who is asking`,
			);
		}
		if (!response.ok) {
			throw new Error(response.error ?? "refused");
		}
		process.stdout.write(`${JSON.stringify({ workspaceId: target.workspaceId, ...response }, null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`${label} failed: ${toErrorMessage(error)}\n`);
		process.exitCode = 1;
	}
}

function parseCount(value: string): number {
	const count = Number(value);
	if (!Number.isInteger(count) || count < 0) {
		throw new Error(`Expected a non-negative whole number, got "${value}".`);
	}
	return count;
}

export function registerPipelineCommand(program: Command): void {
	const pipeline = program.command("pipeline").description("The pipeline: QA gate and landing for landing mode qa.");

	pipeline
		.command("status")
		.description(
			"Print each workspace's landing mode, shadow and pause flags and kit, whether the pipeline runs for it, and its latest decisions (data/<workspace>/pipeline-decisions.jsonl).",
		)
		.option("--workspace <workspace>", "Only this workspace (workspace id or project path).")
		.option("--decisions <count>", "How many of the latest decisions to print per workspace.", parseCount, 10)
		.action(async (options: { workspace?: string; decisions: number }) => {
			try {
				const { config, issues, configPath } = await readPipelineConfig();
				const workspaceIds =
					options.workspace !== undefined
						? [(await resolveWorkspaceTarget(options.workspace, { allowUnregistered: true })).workspaceId]
						: (await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId);
				const workspaces = await Promise.all(
					workspaceIds.map(async (workspaceId) => {
						const settings = getWorkspacePipelineSettings(config, workspaceId);
						return {
							workspaceId,
							landingMode: settings.landing.mode,
							shadow: settings.pipeline.shadow,
							paused: settings.pipeline.paused,
							pausedAt: settings.pipeline.pausedAt,
							kit: settings.kit?.name ?? "default",
							pipeline: !config.pipeline.paused && isPipelineWorkspace(settings),
							decisions: await readLastDecisions(workspaceId, options.decisions),
						};
					}),
				);
				process.stdout.write(
					`${JSON.stringify({ ok: true, configPath, paused: config.pipeline.paused, workspaces, issues }, null, 2)}\n`,
				);
			} catch (error) {
				process.stderr.write(`Pipeline status failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	pipeline
		.command("pause")
		.description(
			"Pause one project's QA pipeline: new QA cards are queued in Backlog and none starts, no QA card is nudged, no PASS lands and no rework is sent until resume. Running QA cards go on; a finished one's verdict is still recorded. Recovery and other projects are unaffected. Only the user and the project's own orchestrator.",
		)
		.option(
			"--workspace <workspace>",
			"Workspace id or project path. Defaults to the project of the current directory.",
		)
		.option("--reason <text>", "Why, for the decision log.")
		.action(async (options: { workspace?: string; reason?: string }) => {
			await setWorkspacePause(options, true);
		});

	pipeline
		.command("resume")
		.description(
			"Resume a paused project's QA pipeline: its queued QA cards start (oldest first, within the QA slots and provider capacity), PASSes land and reworks are sent. Only the user and the project's own orchestrator.",
		)
		.option(
			"--workspace <workspace>",
			"Workspace id or project path. Defaults to the project of the current directory.",
		)
		.option("--reason <text>", "Why, for the decision log.")
		.action(async (options: { workspace?: string; reason?: string }) => {
			await setWorkspacePause(options, false);
		});

	pipeline
		.command("import-legacy")
		.description(
			"Copy the legacy kit's state of one workspace into Kanban's before its shadow goes off (cutover, plan §8.4): open cards' checks-state.json entries → pipeline-state.json, runoffs.json, the scoreboard (deduplicated) and qa-log.md. Reads the legacy files only; safe to run again. Refuses unless the workspace is on landing qa in shadow and the legacy autoland no longer owns it.",
		)
		.requiredOption("--project <workspace>", "Workspace id or project path.")
		.option("--dry-run", "Print what would be copied; write nothing.", false)
		.option("--force", "With --dry-run: plan even while a guard would refuse.", false)
		.option("--json", "Print the report as JSON.", false)
		.action(async (options: { project: string; dryRun: boolean; force: boolean; json: boolean }) => {
			try {
				const target = await resolveWorkspaceTarget(options.project, { allowUnregistered: false });
				const report = await runLegacyImport(
					{
						workspaceId: target.workspaceId,
						repoPath: target.repoPath,
						dryRun: options.dryRun,
						force: options.force,
					},
					{ loadBoard: loadWorkspaceBoardById },
				);
				process.stdout.write(
					options.json
						? `${JSON.stringify({ ok: report.refusals.length === 0, ...report }, null, 2)}\n`
						: `${formatLegacyImportReport(report).join("\n")}\n`,
				);
				if (report.refusals.length > 0 && !options.force) {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`Legacy import failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

	// Started by the Kanban server (src/pipeline/worker-host.ts) with an IPC channel; not for interactive use.
	pipeline
		.command("worker", { hidden: true })
		.description("Run the pipeline worker (the Kanban server starts it).")
		.action(async () => {
			try {
				await runPipelineWorkerProcess();
			} catch (error) {
				process.stderr.write(`Pipeline worker failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
