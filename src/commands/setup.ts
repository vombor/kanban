import type { Command } from "commander";

import { getKanbanRuntimeOrigin, setKanbanRuntimePort } from "../core/runtime-endpoint";
import {
	applyClineModelsSource,
	buildLemonadeModelListUrl,
	type ClineModelsSourceResult,
} from "../setup/cline-models-source";
import { getClineModelsSettingsPath, getKanbanHomePath } from "../state/kanban-home";
import { readLiveKanbanServerLock } from "../state/kanban-server-lock";

interface SetupCommandOptions {
	dryRun?: boolean;
	origin?: string;
	json?: boolean;
}

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

function formatClineModelsSource(result: ClineModelsSourceResult, dryRun: boolean): string[] {
	const lines = [`Cline models.json: ${result.modelsPath}`];
	const current = result.currentUrl ?? "(none)";
	switch (result.action) {
		case "update":
			lines.push(
				`  lemonade modelsSourceUrl: ${current} -> ${result.targetUrl}${dryRun ? " (dry run: not written)" : ""}`,
			);
			if (result.backupPath) {
				lines.push(`  backup: ${result.backupPath}`);
			}
			break;
		case "up-to-date":
			lines.push(`  lemonade modelsSourceUrl: ${current} (up to date)`);
			break;
		case "custom":
			lines.push(`  lemonade modelsSourceUrl: ${current} (${result.detail})`);
			break;
		default:
			lines.push(`  ${result.detail}`);
	}
	return lines;
}

export function registerSetupCommand(program: Command): void {
	program
		.command("setup")
		.description("Configure agent CLIs on this machine for Kanban (Cline's Lemonade model list).")
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--origin <url>", "Kanban server origin agent CLIs should call (default: the running server).")
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
				const clineModelsSource = await applyClineModelsSource({
					modelsPath: getClineModelsSettingsPath(),
					targetUrl: buildLemonadeModelListUrl(choice.origin),
					dryRun,
				});
				const failed = clineModelsSource.action === "error";
				if (options.json) {
					process.stdout.write(
						`${JSON.stringify({ ok: !failed, dryRun, origin: choice, clineModelsSource }, null, 2)}\n`,
					);
				} else {
					const lines = [
						`Kanban server: ${choice.origin} (${choice.source === "server" ? "running server" : choice.source === "flag" ? "--origin" : "runtime port"})`,
						...formatClineModelsSource(clineModelsSource, dryRun),
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
