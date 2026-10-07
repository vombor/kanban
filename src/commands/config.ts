import type { Command } from "commander";

import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

export function registerConfigCommand(program: Command): void {
	const config = program.command("config").description("Show Kanban's pipeline settings (config.json).");
	config
		.command("show")
		.description(
			"Print the core pipeline settings with their defaults filled in, and any section that didn't validate.",
		)
		.option("--workspace <workspace>", "Only this workspace's settings (workspace id or project path).")
		.action(async (options: { workspace?: string }) => {
			try {
				const { config: pipelineConfig, issues, configPath } = await readPipelineConfig();
				if (options.workspace !== undefined) {
					const target = await resolveWorkspaceTarget(options.workspace, { allowUnregistered: true });
					const configured = Object.hasOwn(pipelineConfig.workspaces, target.workspaceId);
					process.stdout.write(
						`${JSON.stringify(
							{
								ok: true,
								configPath,
								workspaceId: target.workspaceId,
								repoPath: target.repoPath,
								// false: no entry in config.json, so these are the defaults (landing off, kit default).
								configured,
								settings: getWorkspacePipelineSettings(pipelineConfig, target.workspaceId),
								issues: issues.filter((issue) => issue.startsWith(`workspaces.${target.workspaceId}:`)),
							},
							null,
							2,
						)}\n`,
					);
					return;
				}
				process.stdout.write(`${JSON.stringify({ ok: true, configPath, ...pipelineConfig, issues }, null, 2)}\n`);
			} catch (error) {
				process.stderr.write(`Config show failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
