// `kanban cline apply-lemonade-models` and `kanban cline remove-bedrock-key`: the user's commands that write Cline's
// files (src/setup/cline-lemonade-apply.ts, src/setup/cline-bedrock-key.ts). `kanban setup` and doctor only print
// them; an agent session can't run them (USER_ONLY_COMMANDS in src/isolation/cli-scope.ts).
import type { Command } from "commander";

import { readLemonadeModelListSettings } from "../config/model-lists-config";
import { readPipelineConfig } from "../config/pipeline-config";
import { removeClineBedrockKey } from "../setup/cline-bedrock-key";
import { getClineBackupDir } from "../setup/cline-file-write";
import { applyClineLemonadeEntry, getClineModelsBackupDir } from "../setup/cline-lemonade-apply";
import { getClineModelsSettingsPath, getClineProvidersSettingsPath, getKanbanHomePath } from "../state/kanban-home";
import { readLiveKanbanServerLock } from "../state/kanban-server-lock";
import { resolveSetupOrigin } from "./setup";

type RootPortOption = { mode: "fixed"; value: number } | { mode: "auto" };

interface RemoveBedrockKeyOptions {
	dryRun?: boolean;
	json?: boolean;
}

interface ApplyLemonadeModelsOptions {
	dryRun?: boolean;
	origin?: string;
	json?: boolean;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

export function registerClineCommand(program: Command): void {
	const cline = program
		.command("cline")
		.description("Cline CLI settings Kanban suggests; you run the commands that write them.");
	cline
		.command("apply-lemonade-models")
		.description(
			"Write Kanban's Lemonade settings into Cline's models.json: the provider's modelsSourceUrl (Kanban's model-lists route) and each model's context window, maxTokens, vision and reasoning as Lemonade reports them now. Only the Lemonade provider entry changes. This is the only way Kanban writes Cline's files, and only when you run it: `kanban setup` and `kanban doctor` just print it. Backs up models.json into the Kanban home (backups/cline/) first and writes atomically.",
		)
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--origin <url>", "Kanban server origin for the model-lists route (default: the running server).")
		.option("--json", "Print the result as JSON.")
		.action(async (options: ApplyLemonadeModelsOptions, command: Command) => {
			try {
				const { port } = command.optsWithGlobals<{ port?: RootPortOption }>();
				const homePath = getKanbanHomePath();
				const { origin } = resolveSetupOrigin({ originFlag: options.origin, portFlag: port, homePath });
				const [{ config }, { settings }] = await Promise.all([
					readPipelineConfig(),
					readLemonadeModelListSettings(),
				]);
				const modelsPath = getClineModelsSettingsPath(config.agents.cline.dataDir);
				const result = await applyClineLemonadeEntry({
					modelsPath,
					origin,
					requireLabels: settings.requireLabels,
					lemonadeUrl: settings.url,
					backupDir: getClineModelsBackupDir(homePath),
					dryRun: options.dryRun === true,
				});
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ modelsPath, origin, ...result }, null, 2)}\n`);
				} else {
					const header: Record<typeof result.status, string> = {
						absent: "nothing to do",
						"in-sync": "in sync, nothing written",
						"would-write": "dry run: not written",
						written: "written",
						error: "not written",
					};
					const lines = [
						`${modelsPath}: ${header[result.status]}`,
						...result.lines.map((line) => `  ${line}`),
						...(result.backupPath ? [`  backup: ${result.backupPath}`] : []),
					];
					process.stdout.write(`${lines.join("\n")}\n`);
				}
				if (result.status === "error") {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`apply-lemonade-models failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
	cline
		.command("remove-bedrock-key")
		.description(
			"Remove the Bedrock API key stored in Cline's providers.json once Kanban's environment provides it (AWS_BEARER_TOKEN_BEDROCK; podman: Secret=<name>,type=env,target=AWS_BEARER_TOKEN_BEDROCK). Only the key field goes: region, model and the other providers stay. Refuses unless AWS_BEARER_TOKEN_BEDROCK is set here, and while the running Kanban server or a Cline hub daemon doesn't have the same value. Backs up providers.json into the Kanban home (backups/cline/) first, writes atomically and prints how to roll back. Never prints a key.",
		)
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--json", "Print the result as JSON.")
		.action(async (options: RemoveBedrockKeyOptions) => {
			try {
				const homePath = getKanbanHomePath();
				const { config } = await readPipelineConfig();
				const providersPath = getClineProvidersSettingsPath(config.agents.cline.dataDir);
				const result = await removeClineBedrockKey({
					providersPath,
					env: process.env,
					dryRun: options.dryRun === true,
					backupDir: getClineBackupDir(homePath),
					launcherDeps: { serverPid: readLiveKanbanServerLock(homePath)?.pid ?? null },
				});
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ providersPath, ...result }, null, 2)}\n`);
				} else {
					const header: Record<typeof result.status, string> = {
						"nothing-to-do": "nothing to do",
						"would-write": "dry run: not written",
						written: "written",
						refused: "refused, nothing written",
						error: "not written",
					};
					const lines = [
						`${providersPath}: ${header[result.status]}`,
						...result.lines.map((line) => `  ${line}`),
						...(result.backupPath ? [`  backup: ${result.backupPath}`] : []),
						...(result.rollback ? [`  to roll back: ${result.rollback}`] : []),
					];
					process.stdout.write(`${lines.join("\n")}\n`);
				}
				if (result.status === "error" || result.status === "refused") {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`remove-bedrock-key failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
