import { basename } from "node:path";

import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import { setKanbanRuntimePort } from "../core/runtime-endpoint";
import { formatKitSelection } from "../kits/renamed-kits";
import { type AddProjectResult, addProject } from "../projects/project-add";
import { type CreateProjectResult, createProject, DEFAULT_INITIAL_BRANCH } from "../projects/project-create";
import { PROJECT_DISPLAY_NAME_MAX_LENGTH } from "../projects/project-display-name";
import { resolveProjectInputPath } from "../projects/project-path";
import { type ProjectRenameIdResult, runProjectIdRename } from "../projects/project-rename-id";
import { syncProjectSections } from "../projects/project-sections";
import { formatUnlinkIgnoredResults, runProjectUnlinkIgnored } from "../projects/project-unlink-ignored";
import { createProcProcessTableReader, isProcessTableSupported } from "../server/process-table";
import type { ProjectNameResponse } from "../trpc/project-name-api";
import { loadWorktreeLinkRule } from "../workspace/worktree-link-rule";
import { parseLandingMode, parsePresetOption, parseSetAssignments } from "./kit";
import { createTerminalKitPrompt } from "./project-kit-prompt";
import { createRuntimeTrpcClient } from "./runtime-trpc-client";
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
		`Kit ${formatKitSelection({ name: result.kitName, preset: result.presetName })}, landing ${result.landingMode}.`,
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

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** `--preset`/`--custom`/`--set` of project add|create, as the kit picks of the new project. */
function readKitPickOptions(options: { kit?: string; preset?: string; custom?: boolean; set: string[] }): {
	preset?: string | null;
	roleSettings?: Record<string, unknown>;
} {
	const preset = parsePresetOption(options);
	if (options.kit === undefined && (preset !== undefined || options.set.length > 0)) {
		throw new Error("--preset, --custom and --set pick the models of --kit team; give --kit team too.");
	}
	return {
		...(preset !== undefined ? { preset } : {}),
		...(options.set.length > 0 ? { roleSettings: parseSetAssignments(options.set) } : {}),
	};
}

export function registerProjectCommand(program: Command): void {
	const project = program.command("project").description("Add Kanban projects and keep their managed files current.");

	project
		.command("add")
		.description(
			"Add a git repo as a Kanban project. A new project picks its routing kit: --kit, else a prompt on a terminal, else default (landing off: every card runs on the selected agent and nothing is QA'd or landed automatically).",
		)
		.argument(
			"<path>",
			"The repo's top directory (its main checkout, not a task worktree), inside a projects root (setting projects.roots).",
		)
		.option(
			"--kit <name>",
			"Routing kit for a new project (kanban kit list; default: default, asked on a terminal). An unknown kit is refused before the project is added.",
		)
		.option("--preset <name>", "The team kit's models: a preset (kanban kit presets).")
		.option(
			"--custom",
			"The team kit with your own models: --set roles.dev.agent=... --set roles.qa.agent=... (required).",
		)
		.option(
			"--set <key=value>",
			"A custom team's role model: roles.<role>.agent|provider|model=<value>. Repeatable.",
			collect,
			[],
		)
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
					preset?: string;
					custom?: boolean;
					set: string[];
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
						...readKitPickOptions(options),
						chooseKit: createTerminalKitPrompt(),
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
			"Create a new project: make the directory (inside a projects root, setting projects.roots), git init it, commit a README.md, and add it like project add on its routing kit (--kit, else a prompt on a terminal, else default; landing off).",
		)
		.argument("<path>", "The new project directory: new, or an empty directory, and not inside another git repo.")
		.option("--name <name>", "Display name and README title (default: the directory name).")
		.option("--branch <branch>", "Initial branch name.", DEFAULT_INITIAL_BRANCH)
		.option("--no-initial-commit", "Only git init: no README.md and no commit (task worktrees need a first commit).")
		.option(
			"--kit <name>",
			"Routing kit (kanban kit list; default: default, asked on a terminal). An unknown kit is refused before anything is created.",
		)
		.option("--preset <name>", "The team kit's models: a preset (kanban kit presets).")
		.option(
			"--custom",
			"The team kit with your own models: --set roles.dev.agent=... --set roles.qa.agent=... (required).",
		)
		.option(
			"--set <key=value>",
			"A custom team's role model: roles.<role>.agent|provider|model=<value>. Repeatable.",
			collect,
			[],
		)
		.option("--json", "Print the result as JSON.")
		.action(
			async (
				path: string,
				options: {
					name?: string;
					branch: string;
					initialCommit: boolean;
					kit?: string;
					preset?: string;
					custom?: boolean;
					set: string[];
					json?: boolean;
				},
			) => {
				try {
					const result = await createProject({
						path: resolveProjectInputPath(path, process.cwd()),
						name: options.name,
						kit: options.kit,
						...readKitPickOptions(options),
						chooseKit: createTerminalKitPrompt(),
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
		.command("rename")
		.description(
			"Set the project's display name (workspaces.<id>.name: the project list, doctor and the scoreboard show it instead of the directory name). Only the user and the project's own orchestrator; the workspace id stays (that is rename-id). Goes through the running server.",
		)
		.argument("<path>", "Project path or workspace id (. for the project containing the current directory).")
		.argument(
			"[name]",
			`The new name: one line of at most ${PROJECT_DISPLAY_NAME_MAX_LENGTH} letters, digits, spaces and . _ - ' & ( ) +.`,
		)
		.option("--clear", "Drop the display name: the directory name is shown again.")
		.option("--json", "Print the result as JSON.")
		.action(async (path: string, name: string | undefined, options: { clear?: boolean; json?: boolean }) => {
			try {
				if ((name === undefined) === (options.clear !== true)) {
					throw new Error("Give either a new name or --clear.");
				}
				const target = await resolveWorkspaceTarget(path === "." ? undefined : path, { allowUnregistered: false });
				let response: ProjectNameResponse;
				try {
					response = await createRuntimeTrpcClient(target.workspaceId).projectName.set.mutate({
						name: options.clear ? null : (name ?? null),
					});
				} catch (error) {
					throw new Error(
						`the running Kanban server didn't answer (${toErrorMessage(error)}); a project's name changes only through it, because it checks who is asking`,
					);
				}
				if (!response.ok) {
					throw new Error(response.error ?? "refused");
				}
				const shown =
					response.name ??
					`its directory name (${target.repoPath ? basename(target.repoPath) : target.workspaceId})`;
				process.stdout.write(
					options.json
						? `${JSON.stringify({ workspaceId: target.workspaceId, ...response }, null, 2)}\n`
						: `${response.changed ? "Renamed" : "Unchanged"}: ${target.workspaceId} is shown as ${shown}${response.changed ? ` (was ${response.previous ?? "its directory name"})` : ""}.\n`,
				);
			} catch (error) {
				process.stderr.write(`Project rename failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});

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

	project
		.command("unlink-ignored")
		.description(
			"Replace the links to the main checkout an older worktree link rule left in the project's task worktrees (a shared database, build output or cache; kanban doctor lists them): a file becomes a copy, a directory an empty one. Worktrees with a running process are skipped. The user's command.",
		)
		.argument("[path]", "Project path or workspace id (default: the project containing the current directory).")
		.option("--dry-run", "List the links and what each would become; change nothing.")
		.option("--json", "Print the result as JSON.")
		.action(async (path: string | undefined, options: { dryRun?: boolean; json?: boolean }) => {
			try {
				const target = await resolveWorkspaceTarget(path, { allowUnregistered: false });
				if (!target.repoPath) {
					throw new Error(`${target.workspaceId} is not a registered project.`);
				}
				const reader = isProcessTableSupported() ? createProcProcessTableReader() : null;
				const results = await runProjectUnlinkIgnored({
					repoPath: target.repoPath,
					rule: await loadWorktreeLinkRule(target.workspaceId),
					dryRun: options.dryRun === true,
					listProcesses: reader ? async () => await reader.list() : null,
					selfPid: process.pid,
				});
				process.stdout.write(
					options.json
						? `${JSON.stringify({ ok: true, workspaceId: target.workspaceId, results }, null, 2)}\n`
						: `${formatUnlinkIgnoredResults(results).join("\n")}\n`,
				);
			} catch (error) {
				process.stderr.write(`Project unlink-ignored failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
