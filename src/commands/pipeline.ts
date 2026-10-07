import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { isPipelineWorkspace } from "../pipeline/engine";
import { runPipelineWorkerProcess } from "../pipeline/worker";
import { getPipelineDecisionLogPath } from "../state/kanban-home";
import { listWorkspaceIndexEntries } from "../state/workspace-state";
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
			"Print each workspace's landing mode, shadow flag and kit, whether the pipeline runs for it, and its latest decisions (data/<workspace>/pipeline-decisions.jsonl).",
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
