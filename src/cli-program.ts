import type { Command } from "commander";
import { registerAgentsCommand } from "./commands/agents";
import { registerBenchCommand } from "./commands/bench";
import { registerBoardCommand } from "./commands/board";
import { registerClineCommand } from "./commands/cline";
import { registerConfigCommand } from "./commands/config";
import { registerDoctorCommand } from "./commands/doctor";
import { registerGitHubCommand } from "./commands/github";
import { registerHomeCommand } from "./commands/home";
import { registerHooksCommand } from "./commands/hooks";
import { registerIsolationCommand } from "./commands/isolation";
import { registerIssuesCommand } from "./commands/issues";
import { registerKitCommand } from "./commands/kit";
import { registerMessageCommand } from "./commands/message";
import { registerModelsCommand } from "./commands/models";
import { registerOrchestratorCommand } from "./commands/orchestrator";
import { registerPipelineCommand } from "./commands/pipeline";
import { registerPlanCommand } from "./commands/plan";
import { registerProjectCommand } from "./commands/project";
import { registerQaCommand } from "./commands/qa";
import { registerRestartCommand } from "./commands/restart";
import { registerSetupCommand } from "./commands/setup";
import { registerShortcutCommand } from "./commands/shortcut";
import { registerTaskCommand } from "./commands/task";
import { parseRuntimePort } from "./core/runtime-endpoint";

export type CliPortValue = { mode: "fixed"; value: number } | { mode: "auto" };

// Root options taking a value. Without positional options, commander matches a root option anywhere in the
// command line, so a root option swallows a subcommand's option of the same name (the root's old `--agent`
// made `models vet --agent` and `orchestrator run --agent` always "not specified"). Don't add a root option
// whose name a subcommand uses.
export const ROOT_OPTIONS_WITH_VALUES = ["--home", "--host", "--port", "--cert", "--key"] as const;

// The launch's deprecated `kanban --agent <id>` (ignored), accepted only before the subcommand.
const DEPRECATED_LAUNCH_AGENT_OPTION = "--agent";

export function parseCliPortValue(rawValue: string): CliPortValue {
	const normalized = rawValue.trim().toLowerCase();
	if (!normalized) {
		throw new Error("Missing value for --port.");
	}
	if (normalized === "auto") {
		return { mode: "auto" };
	}
	try {
		return { mode: "fixed", value: parseRuntimePort(normalized) };
	} catch {
		throw new Error(`Invalid port value: ${rawValue}. Expected an integer from 1-65535 or "auto".`);
	}
}

/** Drops the deprecated launch flag `--agent <id>` from the root options before the first subcommand. */
export function dropDeprecatedLaunchAgentOption(argv: string[]): string[] {
	const result: string[] = [];
	const rootOptionsWithValues = new Set<string>(ROOT_OPTIONS_WITH_VALUES);
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--" || !arg.startsWith("-")) {
			result.push(...argv.slice(index));
			break;
		}
		if (arg === DEPRECATED_LAUNCH_AGENT_OPTION) {
			index += 1;
			continue;
		}
		if (arg.startsWith(`${DEPRECATED_LAUNCH_AGENT_OPTION}=`)) {
			continue;
		}
		result.push(arg);
		if (rootOptionsWithValues.has(arg) && index + 1 < argv.length) {
			index += 1;
			result.push(argv[index] ?? "");
		}
	}
	return result;
}

export function addRootOptions(program: Command): Command {
	return program
		.option("--home <dir>", "Kanban home directory (board state, config, worktrees). Overrides KANBAN_HOME.")
		.option("--host <ip>", "Host IP to bind the server to (default: 127.0.0.1).")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortValue)
		.option("--no-open", "Do not open browser automatically.")
		.option("--skip-shutdown-cleanup", "Do not move sessions to done or delete task worktrees on shutdown.")
		.option("--https", "Enable HTTPS. Requires both --cert and --key.")
		.option("--cert <path>", "Path to a TLS certificate PEM file (implies HTTPS).")
		.option("--key <path>", "Path to a TLS private key PEM file (implies HTTPS).")
		.option("--update", "Update Kanban to the latest published version and exit.")
		.option(
			"--no-passcode",
			"Disable auto-generated passcode for remote access (for advanced users behind a reverse proxy).",
		);
}

export function registerCliCommands(program: Command, version: string): void {
	registerTaskCommand(program);
	registerHooksCommand(program);
	registerAgentsCommand(program);
	registerHomeCommand(program);
	registerSetupCommand(program);
	registerKitCommand(program);
	registerShortcutCommand(program);
	registerConfigCommand(program);
	registerModelsCommand(program);
	registerClineCommand(program);
	registerBenchCommand(program);
	registerPipelineCommand(program);
	registerPlanCommand(program);
	registerRestartCommand(program);
	registerOrchestratorCommand(program);
	registerBoardCommand(program);
	registerProjectCommand(program);
	registerDoctorCommand(program, version);
	registerQaCommand(program);
	registerIsolationCommand(program);
	registerGitHubCommand(program);
	registerIssuesCommand(program);
	registerMessageCommand(program);
}
