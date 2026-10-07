import type { Command } from "commander";

import { readLegacyKitConfig } from "../config/legacy-kit-config";
import { readPipelineConfig } from "../config/pipeline-config";
import { getKanbanRuntimeOrigin, setKanbanRuntimePort } from "../core/runtime-endpoint";
import { runMachineSetup, type SetupResult, type SetupStepOutcome, setupFailed } from "../setup/run-setup";
import { getKanbanHomePath } from "../state/kanban-home";
import { readLiveKanbanServerLock } from "../state/kanban-server-lock";
import { listWorkspaceIndexEntries } from "../state/workspace-state";

type RootPortOption = { mode: "fixed"; value: number } | { mode: "auto" };

export interface SetupOriginChoice {
	origin: string;
	source: "flag" | "server" | "port";
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

/**
 * The Kanban server origin that agent CLIs should call: `--origin`, else an explicit `--port`, else the running
 * server of this home (its `run/server.json`), else the configured runtime origin.
 */
export function resolveSetupOrigin(options: {
	originFlag?: string;
	portFlag?: RootPortOption;
	homePath: string;
}): SetupOriginChoice {
	if (options.originFlag) {
		return { origin: new URL(options.originFlag).origin, source: "flag" };
	}
	if (options.portFlag?.mode === "fixed") {
		setKanbanRuntimePort(options.portFlag.value);
		return { origin: getKanbanRuntimeOrigin(), source: "port" };
	}
	const lock = readLiveKanbanServerLock(options.homePath);
	if (lock) {
		return { origin: new URL(lock.url).origin, source: "server" };
	}
	return { origin: getKanbanRuntimeOrigin(), source: "port" };
}

const STATUS_LABELS: Record<SetupStepOutcome["plan"]["status"], string> = {
	ok: "ok",
	change: "change",
	manual: "to do by hand",
	skipped: "skipped",
	error: "error",
};

function formatSetupResult(result: SetupResult): string[] {
	const lines: string[] = [];
	for (const step of result.steps) {
		const { plan } = step;
		const done =
			plan.status === "change" ? (result.dryRun ? " (dry run: not written)" : step.error ? "" : " (written)") : "";
		lines.push(`${plan.id} (${plan.target}): ${STATUS_LABELS[plan.status]}${done}`);
		lines.push(...plan.details.map((detail) => `  ${detail}`));
		lines.push(...step.applied.filter((line) => line.startsWith("backup:")).map((line) => `  ${line}`));
		if (step.error) {
			lines.push(`  failed: ${step.error}`);
		}
	}
	const untrusted = result.trust.filter((entry) => entry.needsFix);
	lines.push(
		untrusted.length === 0
			? `agent trust: ok (${result.trust.length} project${result.trust.length === 1 ? "" : "s"})`
			: `agent trust: ${untrusted.length} project(s) to trust${result.dryRun ? " (dry run: not written)" : ""}`,
	);
	for (const entry of untrusted) {
		lines.push(
			...(entry.lines.length > 0 ? entry.lines : [`would trust ${entry.repoPath}`]).map((line) => `  ${line}`),
		);
	}
	return lines;
}

interface SetupCommandOptions {
	dryRun?: boolean;
	origin?: string;
	claudeMd?: boolean;
	json?: boolean;
}

export function registerSetupCommand(program: Command): void {
	program
		.command("setup")
		.description(
			"Set up this machine for Kanban: quiet npm, a check that Cline cards can reach Bedrock, Cline's Lemonade model list, the kanban section of ~/.claude/CLAUDE.md, and Claude Code / Codex trust for every project. Only adds what is missing.",
		)
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--origin <url>", "Kanban server origin agent CLIs should call (default: the running server).")
		.option("--claude-md", "Write the CLAUDE.md section even while the legacy kit is installed.")
		.option("--json", "Print the result as JSON.")
		.action(async (options: SetupCommandOptions, command: Command) => {
			try {
				const dryRun = options.dryRun === true;
				const { port } = command.optsWithGlobals<{ port?: RootPortOption }>();
				const choice = resolveSetupOrigin({
					originFlag: options.origin,
					portFlag: port,
					homePath: getKanbanHomePath(),
				});
				const [{ config }, legacyKit, entries] = await Promise.all([
					readPipelineConfig(),
					readLegacyKitConfig(),
					listWorkspaceIndexEntries(),
				]);
				const result = await runMachineSetup({
					origin: choice.origin,
					forceClaudeMd: options.claudeMd === true,
					legacyKitInstalled: legacyKit.raw !== null,
					config,
					dryRun,
					entries,
				});
				const failed = setupFailed(result);
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ ok: !failed, origin: choice, ...result }, null, 2)}\n`);
				} else {
					const lines = [
						`Kanban server: ${choice.origin} (${choice.source === "server" ? "running server" : choice.source === "flag" ? "--origin" : "runtime port"})`,
						...formatSetupResult(result),
					];
					process.stdout.write(`${lines.join("\n")}\n`);
				}
				if (failed) {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`Setup failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
