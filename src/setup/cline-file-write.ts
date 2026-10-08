// How the user's own `kanban cline ...` commands write a Cline file (Kanban writes nothing under ~/.cline on its own,
// user rule 2026-10-07): copy the file as read into the Kanban home's backups (`<home>/backups/cline/`, never next to
// Cline's files; Cline's settings can hold API keys, so the copy is 0600), then replace the file atomically with its
// own mode. Used by apply-lemonade-models (models.json) and remove-bedrock-key (providers.json).
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { getKanbanBackupsPath } from "../state/kanban-home";

const BACKUP_MODE = 0o600;

/** Where the commands keep their copies of Cline's files: `<home>/backups/cline`. */
export function getClineBackupDir(homePath?: string): string {
	return join(getKanbanBackupsPath(homePath), "cline");
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

/** Backs up `raw` (the file as read) as `<backupDir>/<file name>.<UTC timestamp>` and returns the backup's path. */
export async function backupClineFile(input: {
	path: string;
	raw: string;
	backupDir: string;
	now: Date;
}): Promise<string> {
	await mkdir(input.backupDir, { recursive: true, mode: 0o700 });
	return await writeNewBackup(
		join(input.backupDir, `${basename(input.path)}.${backupTimestamp(input.now)}`),
		input.raw,
	);
}

export async function replaceClineFileAtomically(path: string, content: string): Promise<void> {
	const mode = (await stat(path)).mode & 0o7777;
	const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
	await writeFile(tempPath, content, { encoding: "utf8", mode });
	// writeFile's mode is masked by the umask; the replacement keeps the original's mode exactly.
	await chmod(tempPath, mode);
	await rename(tempPath, path);
}
