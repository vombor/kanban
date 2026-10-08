// `kanban cline apply-lemonade-models` and `kanban cline store-bedrock-key`: the user's commands that write Cline's
// files (src/setup/cline-lemonade-apply.ts, src/setup/cline-bedrock-key.ts). `kanban setup` and doctor only print
// them; an agent session can't run them (USER_ONLY_COMMANDS in src/isolation/cli-scope.ts). `remove-bedrock-key`
// only refuses: Cline's TUI needs the stored key (issue #9).
import type { Command } from "commander";

import { readLemonadeModelListSettings } from "../config/model-lists-config";
import { readPipelineConfig } from "../config/pipeline-config";
import {
	type ClineBedrockKeyCommandResult,
	refuseRemoveClineBedrockKey,
	storeClineBedrockKey,
} from "../setup/cline-bedrock-key";
import { getClineBackupDir } from "../setup/cline-file-write";
import { applyClineLemonadeEntry, getClineModelsBackupDir } from "../setup/cline-lemonade-apply";
import { getClineModelsSettingsPath, getClineProvidersSettingsPath, getKanbanHomePath } from "../state/kanban-home";
import { resolveSetupOrigin } from "./setup";

type RootPortOption = { mode: "fixed"; value: number } | { mode: "auto" };

interface BedrockKeyOptions {
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

function printBedrockKeyResult(
	providersPath: string,
	result: ClineBedrockKeyCommandResult,
	options: BedrockKeyOptions,
): void {
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
		.command("store-bedrock-key")
		.description(
			"Store the Bedrock API key from Kanban's environment (AWS_BEARER_TOKEN_BEDROCK; podman: Secret=<name>,type=env,target=AWS_BEARER_TOKEN_BEDROCK) in Cline's providers.json, plus a region (AWS_REGION, else models.bedrockRegion) when none is stored. Cline's TUI only counts a stored key: without one every Cline card on Bedrock opens Cline's sign-in screen. Only those fields change: the model and the other providers stay. Run it again after the secret rotates. Backs up providers.json into the Kanban home (backups/cline/) first, writes atomically and prints how to roll back. Never prints a key.",
		)
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--json", "Print the result as JSON.")
		.action(async (options: BedrockKeyOptions) => {
			try {
				const homePath = getKanbanHomePath();
				const { config } = await readPipelineConfig();
				const providersPath = getClineProvidersSettingsPath(config.agents.cline.dataDir);
				const result = await storeClineBedrockKey({
					providersPath,
					env: process.env,
					defaultRegion: config.models.bedrockRegion,
					dryRun: options.dryRun === true,
					backupDir: getClineBackupDir(homePath),
				});
				printBedrockKeyResult(providersPath, result, options);
			} catch (error) {
				process.stderr.write(`store-bedrock-key failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
	cline
		.command("remove-bedrock-key")
		.description(
			"Refuses: Cline's TUI needs the Bedrock key stored in providers.json (with only AWS_BEARER_TOKEN_BEDROCK it opens Cline's sign-in screen). Use store-bedrock-key to store the environment's key.",
		)
		.option("--dry-run", "Accepted for compatibility; nothing is ever written.")
		.option("--json", "Print the result as JSON.")
		.action(async (options: BedrockKeyOptions) => {
			try {
				const { config } = await readPipelineConfig();
				printBedrockKeyResult(
					getClineProvidersSettingsPath(config.agents.cline.dataDir),
					refuseRemoveClineBedrockKey(),
					options,
				);
			} catch (error) {
				process.stderr.write(`remove-bedrock-key failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
