// `kanban board restore <workspace> [backup]`: puts a saved board back after Kanban wiped a workspace's state (the
// 10/04 "board wiped" incident). It refuses to touch a workspace dir with any files in it (an empty dir is fine:
// Kanban creates it bare when locking), so it can only fill in a wiped board and never overwrite a live one. The
// default backup is the newest board-latest.json (this home's backups/boards/<ws>, else the legacy kit's).
//
// Ported from archive/devteam-kit:tools/recovery/restore-board.sh@6da71597.
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runtimeBoardDataSchema } from "../core/api-contract";
import { getLatestBoardBackupPath } from "./board-backups";
import { getBoardBackupsPath, getLegacyKitLatestBoardBackupPath } from "./kanban-home";
import { getWorkspaceDirectoryPath } from "./workspace-state";

/** Well above any revision the wiped board had, so a browser holding the old one gets a conflict, not a silent save. */
const RESTORED_REVISION = 1000;

export interface RestoreBoardResult {
	workspaceId: string;
	source: string;
	workspaceDir: string;
	cards: number;
	copyOfSource: string;
}

/** Newest first: this home's backup (P4-2's board-backups.ts), then the legacy kit's. */
function getBoardBackupCandidatePaths(workspaceId: string): string[] {
	return [getLatestBoardBackupPath(workspaceId), getLegacyKitLatestBoardBackupPath(workspaceId)];
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
	for (const path of paths) {
		if (
			await readFile(path, "utf8").then(
				() => true,
				() => false,
			)
		) {
			return path;
		}
	}
	return null;
}

export async function restoreBoardFromBackup(options: {
	workspaceId: string;
	backupPath?: string;
	now?: number;
}): Promise<RestoreBoardResult> {
	const now = options.now ?? Date.now();
	const source = options.backupPath ?? (await firstExisting(getBoardBackupCandidatePaths(options.workspaceId)));
	if (!source) {
		throw new Error(
			`No board backup for ${options.workspaceId} (looked in ${getBoardBackupCandidatePaths(options.workspaceId).join(", ")}). Pass the backup file.`,
		);
	}
	const parsed = runtimeBoardDataSchema.safeParse(JSON.parse(await readFile(source, "utf8")));
	if (!parsed.success) {
		throw new Error(`${source} is not a Kanban board: ${parsed.error.issues[0]?.message ?? "invalid"}`);
	}
	const workspaceDir = getWorkspaceDirectoryPath(options.workspaceId);
	const existing = await readdir(workspaceDir).catch(() => [] as string[]);
	const files = existing.filter((name) => !name.startsWith(".lock"));
	if (files.length > 0) {
		throw new Error(`${workspaceDir} is not empty (${files.join(", ")}); not overwriting it.`);
	}
	await mkdir(workspaceDir, { recursive: true });
	await copyFile(source, join(workspaceDir, "board.json"));
	await writeFile(join(workspaceDir, "sessions.json"), "{}\n", "utf8");
	await writeFile(
		join(workspaceDir, "meta.json"),
		`${JSON.stringify({ revision: RESTORED_REVISION, updatedAt: now })}\n`,
		"utf8",
	);
	const backupsDir = getBoardBackupsPath(options.workspaceId);
	await mkdir(backupsDir, { recursive: true });
	const copyOfSource = join(backupsDir, `board-restored-${new Date(now).toISOString().replace(/[-:.]/gu, "")}.json`);
	await copyFile(source, copyOfSource);
	return {
		workspaceId: options.workspaceId,
		source,
		workspaceDir,
		cards: parsed.data.columns.reduce((sum, column) => sum + column.cards.length, 0),
		copyOfSource,
	};
}
