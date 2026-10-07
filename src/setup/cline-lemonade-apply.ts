// `kanban cline apply-lemonade-models`: the one command that writes Cline's models.json, and only when the user runs
// it. Kanban writes nothing under ~/.cline on its own (user rule, 2026-10-07; the user chose "Kanban prints, the user
// applies"): `kanban setup` and doctor only print the differences and this command line.
//
// It changes the Lemonade provider entry and nothing else: `provider.modelsSourceUrl` (cline-models-source.ts) and
// `models` (cline-lemonade-models.ts). Before writing it copies the file as read into the Kanban home's backups
// (`<home>/backups/cline/`, never next to Cline's files; the file can hold API keys, so the copy is 0600), then
// replaces models.json atomically with its own mode. A file that changes while Lemonade is asked is left alone.
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getKanbanBackupsPath } from "../state/kanban-home";
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

const BACKUP_MODE = 0o600;

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
	return join(getKanbanBackupsPath(homePath), "cline");
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

function backupTimestamp(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d+Z$/u, "Z");
}

/** Writes a backup that never replaces another (two runs in the same second get `-1`, `-2`, ...). */
async function writeNewBackup(basePath: string, raw: string): Promise<string> {
	for (let attempt = 0; ; attempt += 1) {
		const path = attempt === 0 ? basePath : `${basePath}-${attempt}`;
		try {
			await writeFile(path, raw, { encoding: "utf8", mode: BACKUP_MODE, flag: "wx" });
			return path;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST") || attempt >= 99) {
				throw error;
			}
		}
	}
}

async function replaceAtomically(path: string, content: string): Promise<void> {
	const mode = (await stat(path)).mode & 0o7777;
	const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
	await writeFile(tempPath, content, { encoding: "utf8", mode });
	// writeFile's mode is masked by the umask; the replacement keeps the original's mode exactly.
	await chmod(tempPath, mode);
	await rename(tempPath, path);
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
	const backupDir = options.backupDir ?? getClineModelsBackupDir();
	await mkdir(backupDir, { recursive: true, mode: 0o700 });
	const backupPath = await writeNewBackup(
		join(backupDir, `models.json.${backupTimestamp(options.now ?? new Date())}`),
		read.raw,
	);
	await replaceAtomically(options.modelsPath, `${JSON.stringify(read.document, null, 2)}\n`);
	return { status: "written", lines, backupPath };
}
