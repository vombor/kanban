// `kanban cline apply-lemonade-models`: the one command that writes Cline's models.json, and only when the user runs
// it. Kanban writes nothing under ~/.cline on its own (user rule, 2026-10-07; the user chose "Kanban prints, the user
// applies"): `kanban setup` and doctor only print the differences and this command line.
//
// It changes the Lemonade provider entry and nothing else: `provider.modelsSourceUrl` (cline-models-source.ts) and
// `models` (cline-lemonade-models.ts). Before writing it copies the file as read into the Kanban home's backups
// (`<home>/backups/cline/`, never next to Cline's files; the file can hold API keys, so the copy is 0600), then
// replaces models.json atomically with its own mode (cline-file-write.ts). A file that changes while Lemonade is asked
// is left alone.
import { readFile } from "node:fs/promises";

import { backupClineFile, getClineBackupDir, replaceClineFileAtomically } from "./cline-file-write";
import {
	isLemonadeModelsDiffEmpty,
	type LemonadeModelsOptions,
	planLemonadeModelsForEntry,
} from "./cline-lemonade-models";
import {
	buildLemonadeModelListUrl,
	CLINE_LEMONADE_PROVIDER_ID,
	planModelsSourceUrl,
	readClineLemonadeEntry,
} from "./cline-models-source";

export const APPLY_LEMONADE_MODELS_COMMAND = "kanban cline apply-lemonade-models";

/** The exact command line setup and doctor print: the user's to run. */
export function formatApplyLemonadeModelsCommand(origin: string): string {
	return `${APPLY_LEMONADE_MODELS_COMMAND} --origin ${new URL(origin).origin}`;
}

/** Setup's and doctor's line telling the user what to run. */
export function formatApplyLemonadeModelsHint(origin: string): string {
	return `to apply, run \`${formatApplyLemonadeModelsCommand(origin)}\` (Kanban itself never writes Cline's models.json)`;
}

/** Where the command keeps its copies of models.json: `<home>/backups/cline`. */
export function getClineModelsBackupDir(homePath?: string): string {
	return getClineBackupDir(homePath);
}

export interface ApplyClineLemonadeOptions extends LemonadeModelsOptions {
	modelsPath: string;
	/** Kanban server origin the model-lists route is on. */
	origin: string;
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
	const targetUrl = buildLemonadeModelListUrl(options.origin);
	const source = planModelsSourceUrl(read.modelsSourceUrl, targetUrl);
	const models = await planLemonadeModelsForEntry(read.entry, options);
	const urlChanges = source.action === "update";
	// With Lemonade down the wanted record is the file's own, so only a list form can differ.
	const modelChanges = !isLemonadeModelsDiffEmpty(models.diff);
	const lines = [
		urlChanges
			? `modelsSourceUrl: ${read.modelsSourceUrl ?? "(none)"} -> ${targetUrl}`
			: `modelsSourceUrl: ${read.modelsSourceUrl ?? "(none)"}${source.action === "custom" ? ` (${source.detail})` : ""}`,
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
		const provider = (lemonade.provider as Record<string, unknown> | undefined) ?? {};
		lemonade.provider = { ...provider, modelsSourceUrl: targetUrl };
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
