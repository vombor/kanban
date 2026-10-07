import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { type AddProjectResult, addProject } from "../projects/project-add";
import { resolveProjectInputPath } from "../projects/project-path";
import { syncProjectSections } from "../projects/project-sections";
import { parseLandingMode } from "./kit";
import { resolveWorkspaceTarget } from "./workspace-target";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function formatAddResult(result: AddProjectResult): string[] {
	const lines = [
		`${result.registered ? "Added" : "Already added"}: ${result.workspaceId} (${result.repoPath})`,
		...result.config.map((line) => `config: ${line}`),
		...result.trust.map((line) => `trust: ${line}`),
	];
	if (result.agentsMd) {
		lines.push(`${result.agentsMd.filePath}: ${result.agentsMd.detail}`);
	}
	lines.push(...result.warnings.map((warning) => `note: ${warning}`));
	lines.push(
		"",
		`Kit ${result.kitName}, landing ${result.landingMode}.`,
		`  kanban kit show --project ${result.workspaceId}   what the kit decides for this project`,
		`  kanban doctor ${result.repoPath}   check it`,
	);
	return lines;
}

export function registerProjectCommand(program: Command): void {
	const project = program.command("project").description("Add Kanban projects and keep their managed files current.");

	project
		.command("add")
		.description(
			"Add a git repo as a Kanban project. Without --kit it is on the default kit with landing off: every card runs on the selected agent and nothing is QA'd or landed automatically.",
		)
		.argument("<path>", "The repo's top directory (its main checkout, not a task worktree).")
		.option("--kit <name>", "Routing kit for the project (kanban kit list).")
		.option("--landing <mode>", "Landing mode: off, commit, pr or qa (default off).")
		.option("--base <branch>", "The branch cards land on (default: detected).")
		.option("--name <name>", "Display name (default: the repo directory name).")
		.option("--blurb <text>", "Project description for QA prompts (the kit override qa.blurb).")
		.option("--agents-md", "Append the managed agents-qa section to the project's AGENTS.md.")
		.option("--json", "Print the result as JSON.")
		.action(
			async (
				path: string,
				options: {
					kit?: string;
					landing?: string;
					base?: string;
					name?: string;
					blurb?: string;
					agentsMd?: boolean;
					json?: boolean;
				},
			) => {
				try {
					const result = await addProject({
						repoPath: resolveProjectInputPath(path, process.cwd()),
						kit: options.kit,
						landing: parseLandingMode(options.landing),
						base: options.base,
						name: options.name,
						blurb: options.blurb,
						agentsMd: options.agentsMd === true,
					});
					process.stdout.write(
						options.json
							? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`
							: `${formatAddResult(result).join("\n")}\n`,
					);
				} catch (error) {
					process.stderr.write(`Project add failed: ${toErrorMessage(error)}\n`);
					process.exitCode = 1;
				}
			},
		);

	project
		.command("sync")
		.description(
			"Rewrite the project's managed sections (AGENTS.md agents-qa) from Kanban's template. Only the text between the markers changes; a file without a section is left alone.",
		)
		.argument("[path]", "Project path or workspace id (default: the project containing the current directory).")
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--json", "Print the result as JSON.")
		.action(async (path: string | undefined, options: { dryRun?: boolean; json?: boolean }) => {
			try {
				const target = await resolveWorkspaceTarget(path, { allowUnregistered: false });
				if (!target.repoPath) {
					throw new Error(`${target.workspaceId} is not a registered project.`);
				}
				const { config } = await readPipelineConfig();
				const results = await syncProjectSections({
					config,
					workspaceId: target.workspaceId,
					repoPath: target.repoPath,
					dryRun: options.dryRun === true,
				});
				process.stdout.write(
					options.json
						? `${JSON.stringify({ ok: true, workspaceId: target.workspaceId, results }, null, 2)}\n`
						: `${results.map((result) => `${result.filePath} ${result.section}: ${result.detail}`).join("\n")}\n`,
				);
			} catch (error) {
				process.stderr.write(`Project sync failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
