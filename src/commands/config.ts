import type { Command } from "commander";

import { type ImportKitResult, importLegacyKitConfig } from "../config/import-kit";
import { getWorkspacePipelineSettings, readPipelineConfig } from "../config/pipeline-config";
import { getLegacyKitConfigPath } from "../state/kanban-home";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function short(value: unknown, max = 100): string {
	const text = JSON.stringify(value) ?? "(none)";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatImportResult(result: ImportKitResult): string[] {
	const { mapping } = result;
	const lines = [`Source: ${mapping.sourcePath}`, `Target: ${result.configPath}`, "", "Core settings:"];
	lines.push(
		...(mapping.core.length > 0
			? mapping.core.map((entry) => `  ${entry.key} = ${short(entry.value)}   (from ${entry.from})`)
			: ["  (none in the file)"]),
	);
	lines.push("", "Workspaces:");
	for (const workspace of mapping.workspaces) {
		const parts = [
			workspace.kit ? `kit ${workspace.kit}` : "no kit (default)",
			`landing ${workspace.landing}`,
			workspace.shadow ? "pipeline.shadow" : null,
			workspace.defaultBaseRef ? `base ${workspace.defaultBaseRef}` : null,
			workspace.name ? `name ${workspace.name}` : null,
		].filter(Boolean);
		lines.push(`  ${workspace.workspaceId}: ${parts.join(", ")}`);
		for (const [key, value] of Object.entries(workspace.overrides)) {
			lines.push(`    override ${key} = ${short(value)}`);
		}
		lines.push(...workspace.notes.map((note) => `    note: ${note}`));
	}
	if (mapping.notImported.length > 0) {
		lines.push("", "Not imported:");
		lines.push(...mapping.notImported.map((entry) => `  ${entry.key}: ${entry.why}`));
	}
	if (mapping.warnings.length > 0) {
		lines.push("", ...mapping.warnings.map((warning) => `Warning: ${warning}`));
	}
	lines.push("", result.written ? "Changed in config.json:" : "Would change in config.json:");
	lines.push(
		...(result.changes.length > 0
			? result.changes.map((change) => `  ${change.key}: ${short(change.from, 60)} -> ${short(change.to, 60)}`)
			: ["  nothing (already imported)"]),
	);
	lines.push(result.written ? "Written." : "Dry run: nothing written.");
	return lines;
}

export function registerConfigCommand(program: Command): void {
	const config = program.command("config").description("Show and import Kanban's pipeline settings (config.json).");
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

	config
		.command("import-kit")
		.description(
			"Map the legacy kit's kit.config.json onto config.json: a project with QA on gets kit team (its differences as overrides, landing qa when it auto-lands, pipeline.shadow), every other project gets the default kit with landing off, and machine-wide keys become core settings. Top-level routing is never copied onto a project.",
		)
		.argument("[file]", `The legacy kit config (default: ${getLegacyKitConfigPath()}).`)
		.option("--dry-run", "Print the mapping and what would change; write nothing.")
		.option("--json", "Print as JSON.")
		.action(async (file: string | undefined, options: { dryRun?: boolean; json?: boolean }) => {
			try {
				const result = await importLegacyKitConfig({ sourcePath: file, dryRun: options.dryRun === true });
				process.stdout.write(
					options.json
						? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`
						: `${formatImportResult(result).join("\n")}\n`,
				);
			} catch (error) {
				process.stderr.write(`Config import-kit failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
