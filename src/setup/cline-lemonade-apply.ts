// `kanban setup-provider lemonade`: the one command that writes Cline's whole Lemonade entry in models.json, and
// only when the user runs it (src/isolation/cli-scope.ts). Kanban writes nothing
// under ~/.cline on its own (user rule, 2026-10-07; the user chose "Kanban prints, the user applies"): `kanban setup`
// and doctor only print the differences and this command line. The one exception is the server's context sync
// (cline-lemonade-context-sync.ts, issue #31): contextWindow and maxTokens of models already in the entry.
//
// It changes the Lemonade provider entry and nothing else: it drops `provider.modelsSourceUrl` (cline-models-source.ts:
// Cline would offer every model a dynamic list returns) and fills in the metadata of the models already in `models`
// (cline-lemonade-models.ts). Which models are in the record is the user's: it never adds or removes
// one (docs/team/MODELS.md). Before writing it copies the file as read into the Kanban home's backups
// (`<home>/backups/cline/`, never next to Cline's files; the file can hold API keys, so the copy is 0600), then
// replaces models.json atomically with its own mode (cline-file-write.ts). A file that changes while Lemonade is asked
// is left alone.
import { readFile } from "node:fs/promises";

import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";
import {
	hasLemonadeModelsChanges,
	type LemonadeModelsOptions,
	planLemonadeModelsForEntry,
} from "./cline-lemonade-models";
import { CLINE_LEMONADE_PROVIDER_ID, planModelsSourceUrl, readClineLemonadeEntry } from "./cline-models-source";
import { formatSetupProviderCommand } from "./setup-provider-command";

/** The exact command line setup and doctor print: the user's to run. */
export function formatApplyLemonadeModelsCommand(): string {
	return formatSetupProviderCommand("lemonade");
}

/** Setup's and doctor's line telling the user what to run. */
export function formatApplyLemonadeModelsHint(): string {
	return `to apply, run \`${formatApplyLemonadeModelsCommand()}\` (Kanban itself only syncs the context windows of models already listed)`;
}

/** Where the command keeps its copies of models.json: `<home>/backups/cline`. */
export function getClineModelsBackupDir(homePath?: string): string {
	return getClineBackupDir(homePath);
}

export interface ApplyClineLemonadeOptions extends LemonadeModelsOptions {
	modelsPath: string;
	/** Default: `<home>/backups/cline`. */
	backupDir?: string;
	dryRun: boolean;
	now?: Date;
}

export interface ApplyClineLemonadeResult {
	/** `absent`: no models.json or no Lemonade provider. `written`/`would-write`: there were differences. */
	status: "absent" | "in-sync" | "written" | "would-write" | "error";
	/** What changes (or is in sync), one line each. */
	lines: string[];
	backupPath: string | null;
}

export async function applyClineLemonadeEntry(options: ApplyClineLemonadeOptions): Promise<ApplyClineLemonadeResult> {
	const read = await readClineLemonadeEntry(options.modelsPath);
	if (read.kind !== "found") {
		return { status: read.kind === "absent" ? "absent" : "error", lines: [read.detail], backupPath: null };
	}
	const source = planModelsSourceUrl(read.modelsSourceUrl);
	const models = await planLemonadeModelsForEntry(read.entry, options);
	const urlChanges = source.action === "remove";
	// With Lemonade down the wanted record is the file's own, so only a list form can differ.
	const modelChanges = hasLemonadeModelsChanges(models);
	const lines = [
		urlChanges ? `modelsSourceUrl: ${read.modelsSourceUrl} -> (none): ${source.detail}` : "modelsSourceUrl: (none)",
		...models.details,
	];
	if (!urlChanges && !modelChanges) {
		return { status: "in-sync", lines, backupPath: null };
	}
	if (options.dryRun) {
		return { status: "would-write", lines, backupPath: null };
	}

	// Lemonade may take seconds; never overwrite an edit made meanwhile.
	if ((await readFile(options.modelsPath, "utf8")) !== read.raw) {
		return {
			status: "error",
			lines: [...lines, "models.json changed while Lemonade was asked; nothing written, run the command again"],
			backupPath: null,
		};
	}
	const providers = read.document.providers as Record<string, Record<string, unknown>>;
	const lemonade = providers[CLINE_LEMONADE_PROVIDER_ID] as Record<string, unknown>;
	if (urlChanges) {
		const { modelsSourceUrl: _dropped, ...provider } =
			(lemonade.provider as Record<string, unknown> | undefined) ?? {};
		lemonade.provider = provider;
	}
	if (models.defaultModel) {
		const provider = (lemonade.provider as Record<string, unknown> | undefined) ?? {};
		lemonade.provider = { ...provider, defaultModelId: models.defaultModel.to };
	}
	if (modelChanges) {
		lemonade.models = models.models;
	}
	const backupPath = await backupClineFile({
		path: options.modelsPath,
		raw: read.raw,
		backupDir: options.backupDir ?? getClineModelsBackupDir(),
		now: options.now ?? new Date(),
	});
	await replaceClineFileAtomically(options.modelsPath, `${JSON.stringify(read.document, null, 2)}\n`);
	return { status: "written", lines, backupPath };
}
