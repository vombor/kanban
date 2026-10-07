// `kanban models probe|providers`: the Bedrock tool-call probe and the one-provider policy for Cline models.
// Ported from the legacy kit's `kit probe-models` (probes/bedrock-converse-probe.mjs, probes/mantle-probe.mjs for
// `--list`) and `kit providers` (bin/providers.mjs). Both only read unless `--apply` is given.
// `kanban models prices sync` (the team kit's price table) lives in model-prices.ts.
import type { Command } from "commander";

import { type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import { type BedrockProbeResult, isNeverProbedModel } from "../models/bedrock-probe";
import { applyCardProviderMigrations, planCardProviderMigrations } from "../models/card-provider-migration";
import {
	cleanupDeprecatedProviders,
	findDeprecatedProviderEntries,
	getProviderSettingsPaths,
	providerForModel,
} from "../models/cline-providers";
import { LEMONADE_PROVIDER_ID, type ModelProbeOutcome, probeModel } from "../models/model-probe";
import { getBedrockProfilesCachePath, loadModelProbeDependencies } from "../models/model-probe-setup";
import { getKanbanBackupsPath } from "../state/kanban-home";
import { listWorkspaceIndexEntries, loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state";
import { registerModelPricesCommand } from "./model-prices";
import { createRuntimeTrpcClient, notifyRuntimeWorkspaceStateUpdated } from "./runtime-trpc-client";
import { resolveWorkspaceTarget } from "./workspace-target";

const US_PROFILE_PREFIX = "us.";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printLines(lines: string[]): void {
	if (lines.length > 0) {
		process.stdout.write(`${lines.join("\n")}\n`);
	}
}

async function readModelsConfig(): Promise<PipelineConfig> {
	const { config, issues } = await readPipelineConfig();
	for (const issue of issues.filter((entry) => entry.startsWith("models") || entry.startsWith("agents"))) {
		process.stderr.write(`config.json: ${issue} (using the defaults)\n`);
	}
	return config;
}

interface ProbeCommandOptions {
	list?: boolean;
	refresh?: boolean;
	provider: string;
	region?: string;
	json?: boolean;
}

function formatProbeOutcome(requested: string, outcome: ModelProbeOutcome): string {
	switch (outcome.kind) {
		case "tool-call": {
			const result: BedrockProbeResult = outcome.result;
			return [result.modelId, result.status ?? "ERR", result.detail, result.elapsedMs].join(" | ");
		}
		case "health":
			return [
				requested,
				outcome.status ?? "ERR",
				`${outcome.up ? "UP" : "DOWN"} ${outcome.detail}`,
				outcome.url,
			].join(" | ");
		case "unsupported":
			return [requested, "-", outcome.reason, 0].join(" | ");
	}
}

async function runProbe(modelIds: string[], options: ProbeCommandOptions): Promise<number> {
	const config = await readModelsConfig();
	const needsBedrock = options.list === true || options.provider !== LEMONADE_PROVIDER_ID;
	const loaded = await loadModelProbeDependencies(config, {
		region: options.region,
		needsBedrock,
		refreshProfiles: options.refresh === true,
	});
	const { region } = loaded;
	const cachePath = getBedrockProfilesCachePath();
	if (needsBedrock && !loaded.hasBedrockKey) {
		process.stderr.write("No Bedrock API key: set BEDROCK_API_KEY or add Cline's bedrock provider.\n");
		return 1;
	}
	if (loaded.warning) {
		process.stderr.write(`warning: ${loaded.warning}\n`);
	}
	const profiles: { profiles: readonly string[]; source: string } = {
		profiles: loaded.deps.bedrock?.profiles ?? [],
		source: loaded.profilesSource,
	};

	if (options.list) {
		const usProfiles = profiles.profiles.filter((id) => id.startsWith(US_PROFILE_PREFIX)).sort();
		if (options.json) {
			printJson({ ok: true, region, source: profiles.source, cachePath, profiles: usProfiles });
		} else {
			printLines(usProfiles);
		}
		return usProfiles.length > 0 ? 0 : 1;
	}

	if (modelIds.length === 0) {
		process.stderr.write("kanban models probe: pass one or more model ids, or --list.\n");
		return 1;
	}
	const probed = modelIds.filter((id) => {
		if (!isNeverProbedModel(id)) {
			return true;
		}
		process.stderr.write(`skipped ${id}: xAI models are never used\n`);
		return false;
	});
	const outcomes = await Promise.all(
		probed.map(async (model) => ({
			model,
			outcome: await probeModel({ provider: options.provider, model }, loaded.deps),
		})),
	);
	if (options.json) {
		printJson({
			ok: outcomes.every(({ outcome }) => outcome.up),
			region,
			provider: options.provider,
			results: outcomes,
		});
	} else {
		printLines(outcomes.map(({ model, outcome }) => formatProbeOutcome(model, outcome)).sort());
	}
	return outcomes.length > 0 && outcomes.every(({ outcome }) => outcome.up) ? 0 : 1;
}

interface ProvidersCommandOptions {
	for?: string;
	cleanup?: boolean;
	migrateCards?: boolean;
	apply?: boolean;
	workspace?: string;
	json?: boolean;
}

async function runProvidersReport(config: PipelineConfig, json: boolean): Promise<number> {
	const policy = config.models.providers;
	const entries = await findDeprecatedProviderEntries(getProviderSettingsPaths(config), policy);
	if (json) {
		printJson({ ok: true, default: policy.default, fallback: policy.fallback, deprecated: entries });
		return 0;
	}
	const lines = [`Default provider: ${policy.default}`];
	for (const [model, provider] of Object.entries(policy.fallback)) {
		lines.push(`Fallback: ${model} -> ${provider}`);
	}
	for (const entry of entries) {
		lines.push(
			`${entry.keep ? "KEEP      " : "DEPRECATED"} ${entry.what}`,
			`           ${entry.file}: ${entry.note}${entry.replacement ? ` -> ${entry.replacement}` : ""}`,
		);
	}
	if (entries.length === 0) {
		lines.push("No deprecated provider settings.");
	}
	printLines(lines);
	return 0;
}

async function runProvidersCleanup(config: PipelineConfig, apply: boolean, json: boolean): Promise<number> {
	const result = await cleanupDeprecatedProviders({
		paths: getProviderSettingsPaths(config),
		policy: config.models.providers,
		apply,
		backupsRoot: getKanbanBackupsPath(),
	});
	if (json) {
		printJson({ ok: result.errors.length === 0, ...result });
		return result.errors.length === 0 ? 0 : 1;
	}
	const lines = result.edits.map((edit) => `${result.applied ? "edit " : "would"} ${edit.file}: ${edit.description}`);
	for (const entry of result.kept) {
		lines.push(`keep  ${entry.file}: ${entry.what} (${entry.note})`);
	}
	if (result.edits.length === 0) {
		lines.push("Nothing to clean up.");
	} else if (!apply) {
		lines.push("Dry run: add --apply to make these edits (both files are backed up first).");
	}
	if (result.backupDir) {
		lines.push(`Backed up to ${result.backupDir}`);
	}
	printLines(lines);
	for (const error of result.errors) {
		process.stderr.write(`Could not read ${error}; left alone.\n`);
	}
	return result.errors.length === 0 ? 0 : 1;
}

async function runMigrateCards(config: PipelineConfig, options: ProvidersCommandOptions): Promise<number> {
	const policy = config.models.providers;
	const targets = options.workspace
		? [await resolveWorkspaceTarget(options.workspace, { allowUnregistered: false })]
		: await listWorkspaceIndexEntries();
	const report: Array<{ workspaceId: string; migrations: ReturnType<typeof planCardProviderMigrations> }> = [];
	for (const target of targets) {
		if (!target.repoPath) {
			continue;
		}
		if (!options.apply) {
			const board = await loadWorkspaceBoardById(target.workspaceId);
			report.push({ workspaceId: target.workspaceId, migrations: planCardProviderMigrations(board, policy) });
			continue;
		}
		const now = Date.now();
		const mutation = await mutateWorkspaceState(target.repoPath, (state) => {
			const migrations = planCardProviderMigrations(state.board, policy);
			return migrations.length === 0
				? { board: state.board, value: migrations, save: false }
				: { board: applyCardProviderMigrations(state.board, migrations, now), value: migrations };
		});
		if (mutation.saved) {
			await notifyRuntimeWorkspaceStateUpdated(createRuntimeTrpcClient(target.workspaceId));
		}
		report.push({ workspaceId: target.workspaceId, migrations: mutation.value });
	}
	if (options.json) {
		printJson({ ok: true, applied: options.apply === true, workspaces: report });
		return 0;
	}
	const lines: string[] = [];
	for (const { workspaceId, migrations } of report) {
		for (const migration of migrations) {
			lines.push(
				`${options.apply ? "moved" : "would"} ${workspaceId}/${migration.taskId} (${migration.column}): ${migration.from}/${migration.model} -> ${migration.to}/${migration.model}`,
			);
		}
	}
	if (lines.length === 0) {
		lines.push("No open cards on a deprecated provider.");
	} else if (!options.apply) {
		lines.push("Dry run: add --apply to update these cards.");
	}
	printLines(lines);
	return 0;
}

async function runProviders(options: ProvidersCommandOptions): Promise<number> {
	const config = await readModelsConfig();
	if (options.for !== undefined) {
		const provider = providerForModel(options.for, config.models.providers);
		if (options.json) {
			printJson({ ok: true, model: options.for, provider });
		} else {
			printLines([provider]);
		}
		return 0;
	}
	if (options.cleanup) {
		return await runProvidersCleanup(config, options.apply === true, options.json === true);
	}
	if (options.migrateCards) {
		return await runMigrateCards(config, options);
	}
	return await runProvidersReport(config, options.json === true);
}

export function registerModelsCommand(program: Command): void {
	const models = program.command("models").description("Probe models and manage the Cline provider policy.");
	models
		.command("probe")
		.description(
			"Ask each model for a tool call through Bedrock Converse (Cline's bedrock provider); exit 1 unless all make one.",
		)
		.argument("[modelIds...]", "Model ids; a model gets its us.* inference profile when Bedrock has one.")
		.option("--list", "List the us.* inference profiles instead.")
		.option("--refresh", "Re-fetch the inference-profile list (cached in the Kanban home's data/models).")
		.option(
			"--provider <id>",
			"Probe as a card on this provider: bedrock (tool call) or lemonade (/health).",
			"bedrock",
		)
		.option("--region <region>", "Bedrock region (default: models.bedrockRegion).")
		.option("--json", "Print JSON.")
		.action(async (modelIds: string[], options: ProbeCommandOptions) => {
			try {
				process.exitCode = await runProbe(modelIds, options);
			} catch (error) {
				process.stderr.write(`Models probe failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
	models
		.command("providers")
		.description(
			"Report deprecated provider settings and the provider each model gets (models.providers); clean them up or move cards off them.",
		)
		.option("--for <modelId>", "Print the provider a new Cline card on this model should use.")
		.option(
			"--cleanup",
			"Remove deprecated providers from Cline's providers.json/models.json (dry run unless --apply).",
		)
		.option(
			"--migrate-cards",
			"Move open cards on a deprecated provider to the model's provider (dry run unless --apply).",
		)
		.option("--apply", "Make the --cleanup or --migrate-cards edits.")
		.option("--workspace <workspace>", "--migrate-cards: only this workspace (id or project path); default all.")
		.option("--json", "Print JSON.")
		.action(async (options: ProvidersCommandOptions) => {
			try {
				process.exitCode = await runProviders(options);
			} catch (error) {
				process.stderr.write(`Models providers failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
	registerModelPricesCommand(models);
}
