import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { setKanbanRuntimePort } from "../core/runtime-endpoint";
import { type AddProjectResult, addProject } from "../projects/project-add";
import { type CreateProjectResult, createProject, DEFAULT_INITIAL_BRANCH } from "../projects/project-create";
import { resolveProjectInputPath } from "../projects/project-path";
import { type ProjectRenameIdResult, runProjectIdRename } from "../projects/project-rename-id";
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

function formatCreateResult(result: CreateProjectResult): string[] {
	return [
		`Created ${result.repoPath} (${result.name}): git init -b ${result.initialBranch}${result.initialCommit ? `, initial commit ${result.initialCommit.slice(0, 7)}` : ""}`,
		...result.notes.map((note) => `note: ${note}`),
		...formatAddResult({ ...result.project, warnings: [] }),
	];
}

type RootPortOption = { mode: "fixed"; value: number } | { mode: "auto" };

function describeRenameStep(step: ProjectRenameIdResult["plan"]["steps"][number]): string {
	const mark = step.done ? "done " : "";
	switch (step.kind) {
		case "move-aside":
			return `${mark}move aside ${step.path} -> ${step.to}`;
		case "move-aside-sessions":
			return `${mark}move aside the leftover home-agent session summaries -> ${step.to}`;
		case "move-aside-config":
			return `${mark}move aside the leftover config.json workspaces entry -> ${step.to}`;
		case "move":
			return `${mark}move ${step.from} -> ${step.to}`;
		case "rewrite":
			return `${mark}rewrite ${step.target}`;
	}
}

function formatRenameResult(result: ProjectRenameIdResult, dryRun: boolean): string[] {
	const { plan } = result;
	const lines = [
		`Home: ${plan.homePath}`,
		`Rename: ${plan.fromId} -> ${plan.toId}${plan.repoPath ? ` (${plan.repoPath})` : ""}`,
	];
	if (plan.blockers.length > 0) {
		lines.push("", "Refusing to rename:", ...plan.blockers.map((blocker) => `  - ${blocker}`));
		return lines;
	}
	if (plan.upToDate) {
		lines.push("", `Nothing to do: ${plan.fromId} is not registered and ${plan.toId} is (an earlier run finished).`);
		return lines;
	}
	if (plan.resumed) {
		lines.push("Finishing an interrupted run (its journal is in run/rename-id.json).");
	}
	lines.push("Steps:", ...plan.steps.map((step) => `  ${describeRenameStep(step)}`));
	if (plan.rewrites.length > 0) {
		lines.push("Rewrites:", ...plan.rewrites.map((rewrite) => `  ${rewrite.file}: ${rewrite.detail}`));
	}
	lines.push(
		"Left as history: decision logs, watchdog and isolation logs, scoreboard, qa-log.md, ATTENTION.md, logs/, backups.",
	);
	if (plan.mentions.length > 0) {
		lines.push(
			`Still naming data/${plan.fromId} or workspaces/${plan.fromId} (history, notes or scripts; left as they are, update your own scripts):`,
			...plan.mentions.map((mention) => `  ${mention}`),
		);
	}
	lines.push(`Server probe: ${plan.probedOrigin} (set with --port or KANBAN_RUNTIME_PORT)`);
	if (dryRun) {
		lines.push("", `Dry run: nothing written. A run writes the backup ${plan.backupPath} first.`);
		return lines;
	}
	lines.push(
		"",
		`Backup: ${result.backupPath ?? plan.backupPath}`,
		`Renamed. Open the project at /${plan.toId} in the browser (links to /${plan.fromId} no longer work).`,
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
		.argument(
			"<path>",
			"The repo's top directory (its main checkout, not a task worktree), inside a projects root (setting projects.roots).",
		)
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
		.command("create")
		.description(
			"Create a new project: make the directory (inside a projects root, setting projects.roots), git init it, commit a README.md, and add it like project add (default kit, landing off).",
		)
		.argument("<path>", "The new project directory: new, or an empty directory, and not inside another git repo.")
		.option("--name <name>", "Display name and README title (default: the directory name).")
		.option("--branch <branch>", "Initial branch name.", DEFAULT_INITIAL_BRANCH)
		.option("--no-initial-commit", "Only git init: no README.md and no commit (task worktrees need a first commit).")
		.option("--json", "Print the result as JSON.")
		.action(
			async (path: string, options: { name?: string; branch: string; initialCommit: boolean; json?: boolean }) => {
				try {
					const result = await createProject({
						path: resolveProjectInputPath(path, process.cwd()),
						name: options.name,
						initialBranch: options.branch,
						initialCommit: options.initialCommit,
					});
					process.stdout.write(
						options.json
							? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`
							: `${formatCreateResult(result).join("\n")}\n`,
					);
				} catch (error) {
					process.stderr.write(`Project create failed: ${toErrorMessage(error)}\n`);
					process.exitCode = 1;
				}
			},
		);

	project
		.command("rename-id")
		.description(
			"Change a project's workspace id: its index entry, board and data dirs, config.json entry and every stored reference. Refuses while a Kanban server runs on the home; backs everything up first; a rerun finishes an interrupted run.",
		)
		.argument("<old-id>", "The project's current workspace id.")
		.argument("<new-id>", "The new id: lowercase letters, digits and dashes, not used by another project.")
		.option(
			"--move-aside",
			"Move state already at the new id that isn't a registered project's (data/<new-id>, ...) to <home>/backups/rename-id-<ts>/.",
		)
		.option("--dry-run", "Print every move and rewrite; write nothing.")
		.option("--json", "Print the result as JSON.")
		.addHelpText(
			"after",
			"\nThe running-server probe asks the runtime port: kanban --port <number> (KANBAN_RUNTIME_PORT, else 3484).",
		)
		.action(
			async (
				oldId: string,
				newId: string,
				options: { moveAside?: boolean; dryRun?: boolean; json?: boolean },
				command: Command,
			) => {
				try {
					// `--port` is the root option (commander parses it there even after the subcommand).
					const { port } = command.optsWithGlobals<{ port?: RootPortOption }>();
					if (port?.mode === "fixed") {
						setKanbanRuntimePort(port.value);
					}
					const result = await runProjectIdRename({
						fromId: oldId,
						toId: newId,
						dryRun: options.dryRun === true,
						moveAside: options.moveAside === true,
					});
					const failed = result.plan.blockers.length > 0;
					process.stdout.write(
						options.json
							? `${JSON.stringify({ ok: !failed, ...result }, null, 2)}\n`
							: `${formatRenameResult(result, options.dryRun === true).join("\n")}\n`,
					);
					if (failed) {
						process.exitCode = 1;
					}
				} catch (error) {
					process.stderr.write(`Project rename-id failed: ${toErrorMessage(error)}\n`);
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
