// Board backups (plan §2.6): every board.json write also writes `backups/boards/<workspaceId>/board-latest.json`,
// plus a timestamped `board-<UTC>.json` at most every `backups.board.everyMin` minutes, keeping the newest
// `backups.board.keep`. They live outside `workspaces/` on purpose: Kanban removes a workspace's whole state dir
// when it thinks the repo is gone (one failed `git rev-parse` under thread exhaustion was enough), and the backups
// must survive that. A backup that fails never fails the write it follows.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (backupBoard), moved from the legacy kit's
// board.json watch into the write path, so a write is never missed between two watch events.
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardData } from "../core/api-contract";
import { getBoardBackupsPath } from "./kanban-home";

export type BoardBackupSettings = PipelineConfig["backups"]["board"];

const LATEST_FILENAME = "board-latest.json";

/** The newest backup of a workspace's board (`backups/boards/<workspaceId>/board-latest.json`). */
export function getLatestBoardBackupPath(workspaceId: string): string {
	return join(getBoardBackupsPath(workspaceId), LATEST_FILENAME);
}
const STAMPED_FILENAME = /^board-(\d{8}T\d{6})\.json$/;

export interface BoardBackups {
	backup: (workspaceId: string, board: RuntimeBoardData) => Promise<void>;
}

export interface CreateBoardBackupsOptions {
	readSettings?: () => Promise<BoardBackupSettings>;
	getDir?: (workspaceId: string) => string;
	now?: () => number;
	onError?: (workspaceId: string, error: unknown) => void;
}

/** `20261004T231000` for 2026-10-04T23:10:00Z. */
export function formatBackupStamp(epochMs: number): string {
	return new Date(epochMs).toISOString().replace(/[-:]/g, "").slice(0, 15);
}

function parseBackupStamp(stamp: string): number {
	const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
	return Date.parse(iso);
}

export function createBoardBackups(options: CreateBoardBackupsOptions = {}): BoardBackups {
	const readSettings = options.readSettings ?? (async () => (await readPipelineConfig()).config.backups.board);
	const getDir = options.getDir ?? getBoardBackupsPath;
	const now = options.now ?? Date.now;
	// backup dir → epoch ms of its newest timestamped copy (read from the dir once, then kept here).
	const lastStamped = new Map<string, number>();
	let warned = false;
	const onError =
		options.onError ??
		((workspaceId: string, error: unknown) => {
			if (!warned) {
				warned = true;
				process.emitWarning(
					`board backup for ${workspaceId} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});

	const listStamped = async (dir: string): Promise<string[]> =>
		(await readdir(dir)).filter((file) => STAMPED_FILENAME.test(file)).sort();

	const newestStamped = async (dir: string): Promise<number> => {
		const cached = lastStamped.get(dir);
		if (cached !== undefined) {
			return cached;
		}
		const newest = (await listStamped(dir)).reduce((max, file) => {
			const match = STAMPED_FILENAME.exec(file);
			return match?.[1] ? Math.max(max, parseBackupStamp(match[1])) : max;
		}, 0);
		lastStamped.set(dir, newest);
		return newest;
	};

	return {
		backup: async (workspaceId, board) => {
			try {
				const settings = await readSettings();
				if (!settings.enabled) {
					return;
				}
				const dir = getDir(workspaceId);
				await mkdir(dir, { recursive: true });
				const text = JSON.stringify(board, null, 2);
				const latest = join(dir, LATEST_FILENAME);
				await writeFile(`${latest}.tmp`, text, "utf8");
				await rename(`${latest}.tmp`, latest);
				const at = now();
				if (at - (await newestStamped(dir)) < settings.everyMin * 60_000) {
					return;
				}
				await writeFile(join(dir, `board-${formatBackupStamp(at)}.json`), text, "utf8");
				lastStamped.set(dir, at);
				for (const old of (await listStamped(dir)).slice(0, -settings.keep)) {
					await rm(join(dir, old), { force: true });
				}
			} catch (error) {
				onError(workspaceId, error);
			}
		},
	};
}

/** The process-wide instance the workspace state writes use. */
export const boardBackups = createBoardBackups();
