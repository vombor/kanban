import type { Command } from "commander";

import { formatDoctorReport, toDoctorJson } from "../doctor/doctor-report";
import { runDoctor } from "../doctor/run-doctor";
import { getKanbanHomePath } from "../state/kanban-home";
import { resolveSetupOrigin } from "./setup";

interface DoctorCommandOptions {
	fix?: boolean;
	deep?: boolean;
	verbose?: boolean;
	json?: boolean;
}

type RootPortOption = { mode: "fixed"; value: number } | { mode: "auto" };

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

export function registerDoctorCommand(program: Command, kanbanVersion: string): void {
	program
		.command("doctor")
		.description(
			"Check the Kanban home, every project's kit and landing mode, agent trust, managed sections, machine setup, and that the legacy kit and Kanban never both own a job. Exits 1 when a check fails.",
		)
		.argument("[path]", "A project that should be registered (e.g. the workspace you work in).")
		.option(
			"--fix",
			"Apply the safe fixes: register [path] (kit default, landing off), agent trust, managed sections, worktree push hooks.",
		)
		.option("--deep", "Also check agent CLIs, env, ssh key and Cline providers (slower; runs each CLI's --version).")
		.option("--verbose", "Also print the checks that pass.")
		.option("--json", "Print the findings as JSON.")
		.action(async (path: string | undefined, options: DoctorCommandOptions, command: Command) => {
			try {
				const { port } = command.optsWithGlobals<{ port?: RootPortOption }>();
				const { origin } = resolveSetupOrigin({ portFlag: port, homePath: getKanbanHomePath() });
				const fix = options.fix === true;
				const report = await runDoctor({ target: path, fix, deep: options.deep === true, origin, kanbanVersion });
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ ok: true, ...toDoctorJson(report) }, null, 2)}\n`);
				} else {
					process.stdout.write(
						`${formatDoctorReport(report, { verbose: options.verbose === true || options.deep === true, fix }).join("\n")}\n`,
					);
				}
				if (report.findings.some((finding) => finding.level === "fail")) {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`Doctor failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
