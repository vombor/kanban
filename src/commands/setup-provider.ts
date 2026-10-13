// `kanban setup-provider [<provider>]`: writes one model provider's Cline settings (the providers and what each writes:
// src/setup/cline-provider-setup.ts); with no provider it lists them and whether each is in sync (the doctor rows'
// answer). It is the user's to run (KANBAN_ORCHESTRATOR_OR_USER_COMMANDS in src/isolation/cli-scope.ts, asked of the
// server before this runs; docs/fork/development.md); `kanban setup` and doctor only print it.
import type { Command } from "commander";

import { readPipelineConfig } from "../config/pipeline-config";
import {
	describeProviderSyncStatuses,
	findClineProviderSetup,
	listClineProviderSetups,
	type ProviderSetupContext,
	type ProviderSetupResult,
	type ProviderSyncStatus,
} from "../setup/cline-provider-setup";
import { SETUP_PROVIDER_IDS } from "../setup/setup-provider-command";
import { getKanbanHomePath } from "../state/kanban-home";

export interface SetupProviderOptions {
	dryRun?: boolean;
	json?: boolean;
}

const RESULT_HEADERS: Record<ProviderSetupResult["status"], string> = {
	"nothing-to-do": "nothing to do",
	"in-sync": "in sync, nothing written",
	"would-write": "dry run: not written",
	written: "written",
	refused: "refused, nothing written",
	error: "not written",
};

const STATE_LABELS: Record<ProviderSyncStatus["state"], string> = {
	"in-sync": "in sync",
	"out-of-sync": "out of sync",
	"not-in-use": "not in use",
	unknown: "unknown",
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function formatResult(result: ProviderSetupResult): string {
	return [
		`${result.provider} (${result.path}): ${RESULT_HEADERS[result.status]}`,
		...result.lines.map((line) => `  ${line}`),
		...result.backupPaths.map((path) => `  backup: ${path}`),
		...(result.rollback ? [`  to roll back: ${result.rollback}`] : []),
	].join("\n");
}

function formatStatuses(statuses: readonly ProviderSyncStatus[], context: ProviderSetupContext): string {
	const width = Math.max(...statuses.map((status) => status.provider.length));
	const lines = statuses.flatMap((status) => {
		const setup = findClineProviderSetup(status.provider, context.config);
		const head = `${status.provider.padEnd(width)}  ${STATE_LABELS[status.state]}${setup ? ` (${setup.label})` : ""}`;
		const details = status.findings
			.filter((finding) => status.state !== "in-sync" || finding.level !== "pass")
			.map((finding) => `  ${" ".repeat(width)}${finding.message}${finding.hint ? ` -> ${finding.hint}` : ""}`);
		return [head, ...(setup ? [`  ${" ".repeat(width)}writes ${setup.writes}`] : []), ...details];
	});
	return [...lines, "", "Run `kanban setup-provider <provider> --dry-run` to see what would change."].join("\n");
}

export interface SetupProviderCommandInput {
	/** The provider argument; undefined lists them. */
	provider: string | undefined;
	options: SetupProviderOptions;
	context: ProviderSetupContext;
}

export interface SetupProviderCommandOutput {
	stdout: string;
	exitCode: 0 | 1;
}

/** The command without its CLI wiring: the provider list, or one provider's write (tests call it directly). */
export async function runSetupProviderCommand(input: SetupProviderCommandInput): Promise<SetupProviderCommandOutput> {
	const { provider, options, context } = input;
	if (provider === undefined) {
		const statuses = await describeProviderSyncStatuses(context);
		const listed = statuses.map(({ provider: id, state, findings }) => ({
			provider: id,
			state,
			findings: findings.map(({ level, message, hint }) => ({ level, message, hint })),
		}));
		return {
			stdout: options.json ? `${JSON.stringify(listed, null, 2)}\n` : `${formatStatuses(statuses, context)}\n`,
			exitCode: 0,
		};
	}
	const setups = listClineProviderSetups(context.config);
	const setup = setups.find((entry) => entry.id === provider);
	if (!setup) {
		throw new Error(
			`unknown provider "${provider}"; one of ${setups.map((entry) => entry.id).join(", ")} (an OpenAI-compatible server goes into config.json's providers.openaiCompatible first)`,
		);
	}
	const result = await setup.apply(context, { dryRun: options.dryRun === true });
	return {
		stdout: options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatResult(result)}\n`,
		exitCode: result.status === "error" || result.status === "refused" ? 1 : 0,
	};
}

export function registerSetupProviderCommand(program: Command): void {
	program
		.command("setup-provider")
		.argument(
			"[provider]",
			`The provider to set up: ${SETUP_PROVIDER_IDS.join(", ")}, or an OpenAI-compatible provider of config.json (providers.openaiCompatible.<id>). Without one, lists them.`,
		)
		.description(
			"Write a model provider's settings into Cline's files (models.json, providers.json) as Kanban needs them for Cline cards, or with no provider list the providers and whether each is in sync. Each provider changes only its own entry, backs the file up into the Kanban home (backups/cline/) first, writes atomically and never prints a key; keys come from Kanban's environment, never the command line. It is the user's to run (agent sessions are refused); `kanban setup` and `kanban doctor` just print it. The server's Lemonade context sync (agents.cline.lemonadeContextSync) is separate.",
		)
		.option("--dry-run", "Print what would change; write nothing.")
		.option("--json", "Print the result as JSON.")
		.action(async (provider: string | undefined, options: SetupProviderOptions) => {
			try {
				const homePath = getKanbanHomePath();
				const { config } = await readPipelineConfig();
				const output = await runSetupProviderCommand({
					provider,
					options,
					context: { config, homePath, env: process.env },
				});
				process.stdout.write(output.stdout);
				if (output.exitCode !== 0) {
					process.exitCode = output.exitCode;
				}
			} catch (error) {
				process.stderr.write(`setup-provider failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
