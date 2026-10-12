// The model providers `kanban setup-provider <provider>` sets up for Cline cards (src/commands/setup-provider.ts):
// one row per provider, with what it writes, its sync check (the doctor row's answer) and its write. Each write is the
// provider's own module, unchanged: the plan and diff, the backup into `<home>/backups/cline`, the atomic write
// through cline-file-write.ts, only that provider's keys, and never a printed secret. Kanban writes these only when
// the user or the Kanban project's orchestrator runs the command (KANBAN_ORCHESTRATOR_OR_USER_COMMANDS in
// src/isolation/cli-scope.ts); the server's Lemonade context sync stays its own (cline-lemonade-context-sync.ts).
//
// Which models a provider's `models` record in models.json lists is the Kanban orchestrator's (the record is Cline's
// allow list, docs/team/MODELS.md): a provider's write keeps the records it finds and only fills in or refreshes their
// metadata (context window, maxTokens, vision, reasoning), never adds or removes a model, and drops a
// `modelsSourceUrl` (Cline offers every id it returns). A new provider type here follows the same rule.
// After the built-in rows come the OpenAI-compatible providers of config.json (`providers.openaiCompatible.<id>`), one
// row each, all through the one generic module (cline-openai-compatible-provider.ts).
import { readLemonadeModelListSettings } from "../config/model-lists-config";
import type { OpenAiCompatibleProviderSettings } from "../config/openai-compatible-providers-config";
import type { PipelineConfig } from "../config/pipeline-config";
import { checkClineBedrockKey } from "../doctor/cline-bedrock-key-checks";
import { checkClineLemonadeModels } from "../doctor/cline-models-checks";
import { checkClinePassKey } from "../doctor/cline-pass-key-checks";
import type { DoctorFinding } from "../doctor/doctor-report";
import { checkOpenAiCompatibleProvider } from "../doctor/openai-compatible-provider-checks";
import {
	getClineLemonadeSyncHistoryPath,
	getClineModelsSettingsPath,
	getClineProvidersSettingsPath,
} from "../state/kanban-home";
import { CLINE_PASS_PROVIDER_ID } from "../terminal/cline-tui-sign-in";
import { type ClineBedrockKeyCommandResult, storeClineBedrockKey } from "./cline-bedrock-key";
import { getClineBackupDir } from "./cline-file-write";
import { applyClineLemonadeEntry } from "./cline-lemonade-apply";
import { applyClineOpenAiCompatibleProvider } from "./cline-openai-compatible-provider";
import { type ClinePassKeyCommandResult, storeClinePassKey } from "./cline-pass-key";
import type { SetupProviderId } from "./setup-provider-command";

export interface ProviderSetupContext {
	config: PipelineConfig;
	homePath: string;
	/** Where the keys come from (AWS_BEARER_TOKEN_BEDROCK, CLINE_API_KEY); never printed. */
	env: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	now?: Date;
}

export interface ProviderSetupResult {
	provider: SetupProviderId;
	/** The file the provider's settings are in. */
	path: string;
	/** `refused`: a precondition failed, nothing written; `error`: the file can't be used or changed meanwhile. */
	status: "nothing-to-do" | "in-sync" | "would-write" | "written" | "refused" | "error";
	/** What changes (or why not), one line each. */
	lines: string[];
	backupPaths: string[];
	/** The command that puts the backup back, when the write printed one. */
	rollback: string | null;
}

/** Whether a provider's Cline settings match what Kanban wants: the doctor row's answer. */
export interface ProviderSyncStatus {
	provider: SetupProviderId;
	/** `not-in-use`: the doctor row has nothing to say; `unknown`: it couldn't tell (e.g. Lemonade is down). */
	state: "in-sync" | "out-of-sync" | "not-in-use" | "unknown";
	findings: DoctorFinding[];
}

export interface ClineProviderSetup {
	id: SetupProviderId;
	label: string;
	/** What the write changes, for the provider list. */
	writes: string;
	check: (context: ProviderSetupContext) => Promise<DoctorFinding[]>;
	apply: (context: ProviderSetupContext, options: { dryRun: boolean }) => Promise<ProviderSetupResult>;
}

function fromKeyCommand(
	provider: SetupProviderId,
	path: string,
	result: ClineBedrockKeyCommandResult | ClinePassKeyCommandResult,
): ProviderSetupResult {
	return {
		provider,
		path,
		status: result.status,
		lines: result.lines,
		backupPaths: result.backupPath ? [result.backupPath] : [],
		rollback: result.rollback,
	};
}

const lemonade: ClineProviderSetup = {
	id: "lemonade",
	label: "Lemonade (local models)",
	writes:
		"models.json: drops the lemonade entry's modelsSourceUrl, and fills in the context window, maxTokens, vision and reasoning of the models already in its record as Lemonade reports them (never adds or removes a model)",
	check: async (context) =>
		await checkClineLemonadeModels({
			modelsPath: getClineModelsSettingsPath(context.config.agents.cline.dataDir),
			lemonadeModelList: (await readLemonadeModelListSettings()).settings,
			contextSync: context.config.agents.cline.lemonadeContextSync,
			historyPath: getClineLemonadeSyncHistoryPath(context.homePath),
			fetch: context.fetch,
		}),
	apply: async (context, { dryRun }) => {
		const modelsPath = getClineModelsSettingsPath(context.config.agents.cline.dataDir);
		const { settings } = await readLemonadeModelListSettings();
		const result = await applyClineLemonadeEntry({
			modelsPath,
			lemonadeUrl: settings.url,
			fetch: context.fetch,
			backupDir: getClineBackupDir(context.homePath),
			dryRun,
			now: context.now,
		});
		return {
			provider: "lemonade",
			path: modelsPath,
			status: result.status === "absent" ? "nothing-to-do" : result.status,
			lines: result.lines,
			backupPaths: result.backupPath ? [result.backupPath] : [],
			rollback: null,
		};
	},
};

const bedrock: ClineProviderSetup = {
	id: "bedrock",
	label: "Amazon Bedrock",
	writes:
		"providers.json: the bedrock entry's apiKey from AWS_BEARER_TOKEN_BEDROCK, and a region (AWS_REGION, else models.bedrockRegion) when none is stored",
	check: async (context) =>
		await checkClineBedrockKey({
			providersPath: getClineProvidersSettingsPath(context.config.agents.cline.dataDir),
			defaultProvider: context.config.models.providers.default,
			env: context.env,
		}),
	apply: async (context, { dryRun }) => {
		const providersPath = getClineProvidersSettingsPath(context.config.agents.cline.dataDir);
		const result = await storeClineBedrockKey({
			providersPath,
			env: context.env,
			defaultRegion: context.config.models.bedrockRegion,
			dryRun,
			backupDir: getClineBackupDir(context.homePath),
			now: context.now,
		});
		return fromKeyCommand("bedrock", providersPath, result);
	},
};

const clinePass: ClineProviderSetup = {
	id: CLINE_PASS_PROVIDER_ID,
	label: "ClinePass (Cline's subscription)",
	writes: "providers.json: the cline-pass entry's apiKey from CLINE_API_KEY",
	check: async (context) =>
		await checkClinePassKey({
			providersPath: getClineProvidersSettingsPath(context.config.agents.cline.dataDir),
			defaultProvider: context.config.models.providers.default,
			env: context.env,
		}),
	apply: async (context, { dryRun }) => {
		const providersPath = getClineProvidersSettingsPath(context.config.agents.cline.dataDir);
		const result = await storeClinePassKey({
			providersPath,
			env: context.env,
			dryRun,
			backupDir: getClineBackupDir(context.homePath),
			now: context.now,
		});
		return fromKeyCommand(CLINE_PASS_PROVIDER_ID, providersPath, result);
	},
};

/** The providers with their own code, in the order the command lists them. */
export const CLINE_PROVIDER_SETUPS: readonly ClineProviderSetup[] = [lemonade, bedrock, clinePass];

function createOpenAiCompatibleSetup(id: string, provider: OpenAiCompatibleProviderSettings): ClineProviderSetup {
	const paths = (context: ProviderSetupContext) => ({
		modelsPath: getClineModelsSettingsPath(context.config.agents.cline.dataDir),
		providersPath: getClineProvidersSettingsPath(context.config.agents.cline.dataDir),
	});
	return {
		id,
		label: `${provider.name} (OpenAI-compatible${provider.local ? ", local" : ""})`,
		writes: `models.json: the ${id} entry's provider (name, baseUrl) and the context window and maxTokens of the models it already has; providers.json: the ${id} entry's provider, baseUrl and model${provider.apiKeyEnv ? ` and apiKey from ${provider.apiKeyEnv}` : ""}`,
		check: async (context) =>
			await checkOpenAiCompatibleProvider({
				providerId: id,
				provider,
				...paths(context),
				env: context.env,
				fetch: context.fetch,
			}),
		apply: async (context, { dryRun }) => {
			const { modelsPath, providersPath } = paths(context);
			const result = await applyClineOpenAiCompatibleProvider({
				providerId: id,
				provider,
				modelsPath,
				providersPath,
				env: context.env,
				fetch: context.fetch,
				backupDir: getClineBackupDir(context.homePath),
				dryRun,
				now: context.now,
			});
			return {
				provider: id,
				path: `${modelsPath}, ${providersPath}`,
				status: result.status,
				lines: result.lines,
				backupPaths: result.backupPaths,
				rollback: result.rollback,
			};
		},
	};
}

/** Every provider `kanban setup-provider` knows for this config.json: the built-in ones, then the configured ones. */
export function listClineProviderSetups(config: PipelineConfig): ClineProviderSetup[] {
	return [
		...CLINE_PROVIDER_SETUPS,
		...Object.entries(config.providers.openaiCompatible).map(([id, provider]) =>
			createOpenAiCompatibleSetup(id, provider),
		),
	];
}

export function findClineProviderSetup(id: string, config: PipelineConfig): ClineProviderSetup | null {
	return listClineProviderSetups(config).find((setup) => setup.id === id) ?? null;
}

/** The doctor row's findings as one state: any warning or failure is out of sync, an INFO alone is unknown. */
export function summarizeProviderFindings(findings: readonly DoctorFinding[]): ProviderSyncStatus["state"] {
	if (findings.length === 0) {
		return "not-in-use";
	}
	if (findings.some((finding) => finding.level === "warn" || finding.level === "fail")) {
		return "out-of-sync";
	}
	return findings.some((finding) => finding.level === "info") ? "unknown" : "in-sync";
}

export async function describeProviderSyncStatuses(context: ProviderSetupContext): Promise<ProviderSyncStatus[]> {
	return await Promise.all(
		listClineProviderSetups(context.config).map(async (setup) => {
			const findings = await setup.check(context);
			return { provider: setup.id, state: summarizeProviderFindings(findings), findings };
		}),
	);
}
