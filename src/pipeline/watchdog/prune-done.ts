// Keeps the Done column small: 153 Done cards (mostly QA and calibration prompts) made board.json 1 MB and the board
// stopped loading on the user's phone (10/06). Deletes Done cards older than `days` after a backup of the workspace's
// board/sessions/meta files plus an index of what was deleted (`<home>/backups/boards/<ws>/prune-done-<ts>/`). Their
// results are in the pipeline data (QA log, scoreboard, runoffs, calibration) and their code in git (snapshot refs,
// preserve/* tags), so nothing lives only on the card. Done cards' worktrees are already gone (the Done workflow
// deletes them), so this only edits the board.
//
// Skips cards of an undecided runoff and of a calibration that is still running. Used by `kanban board prune-done`
// (in-process) and by the watchdog's hourly job (through the server, which owns the board).
//
// Ported from archive/devteam-kit:bin/prune-done.mjs@6da71597 (01df7bb, 760fd36).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeBoardCard } from "../../core/api-contract";
import { deleteTasksFromBoard } from "../../core/task-board-mutations";
import { getBoardBackupsPath, getWatchdogWorkspacePaths } from "../../state/kanban-home";
import { mutateWorkspaceState } from "../../state/workspace-state";
import { readCalibrationRunIds, readUndecidedRunoffCardIds } from "./workspace-data";

const DAY_MS = 86_400_000;

export interface PruneDoneOptions {
	workspaceId: string;
	repoPath: string;
	days: number;
	dryRun?: boolean;
	now?: number;
}

export interface PruneDoneResult {
	doneCount: number;
	/** Done cards old enough but kept (undecided runoff, running calibration). */
	kept: string[];
	/** Deleted (or, with dryRun, would be deleted). */
	pruned: Array<{ id: string; title: string }>;
	backupPath: string | null;
	dryRun: boolean;
	summary: string;
}

function cardTitle(card: RuntimeBoardCard): string {
	return (card.title ?? card.prompt ?? "").replace(/\s+/gu, " ").slice(0, 60);
}

function timestampForPath(now: number): string {
	return new Date(now).toISOString().slice(0, 16).replace(/[-:]/gu, "");
}

export async function pruneDoneCards(options: PruneDoneOptions): Promise<PruneDoneResult> {
	const now = options.now ?? Date.now();
	const cutoff = now - options.days * DAY_MS;
	const paths = getWatchdogWorkspacePaths(options.workspaceId);
	const keep = new Set([
		...(await readUndecidedRunoffCardIds(paths.runoffs)),
		...(await readCalibrationRunIds(paths.calibrationDir, { onlyUnfinished: true })),
	]);
	const backupPath = join(getBoardBackupsPath(options.workspaceId), `prune-done-${timestampForPath(now)}`);
	const select = (cards: readonly RuntimeBoardCard[]) => {
		const old = cards.filter((card) => (card.updatedAt ?? card.createdAt ?? 0) < cutoff);
		return { old: old.filter((card) => !keep.has(card.id)), kept: old.filter((card) => keep.has(card.id)) };
	};
	let backedUp = false;

	const mutation = await mutateWorkspaceState(options.repoPath, (state) => {
		const done = state.board.columns.find((column) => column.id === "trash")?.cards ?? [];
		const { old, kept } = select(done);
		const value = {
			doneCount: done.length,
			kept: kept.map((card) => card.id),
			pruned: old.map((card) => ({ id: card.id, title: cardTitle(card), card })),
			// The state as it was before this write, for the backup.
			before: { board: state.board, sessions: state.sessions, revision: state.revision },
		};
		if (old.length === 0 || options.dryRun) {
			return { board: state.board, value, save: false };
		}
		const deleted = deleteTasksFromBoard(
			state.board,
			old.map((card) => card.id),
		);
		return { board: deleted.board, value, save: deleted.deleted };
	});

	const { doneCount, kept } = mutation.value;
	const pruned = mutation.value.pruned;
	if (mutation.saved) {
		// The backup is the state the mutation read under the workspace lock, so it is exactly what was replaced.
		const { before } = mutation.value;
		await mkdir(backupPath, { recursive: true });
		await writeFile(join(backupPath, "board.json"), JSON.stringify(before.board, null, 2), "utf8");
		await writeFile(join(backupPath, "sessions.json"), JSON.stringify(before.sessions, null, 2), "utf8");
		await writeFile(
			join(backupPath, "meta.json"),
			JSON.stringify({ revision: before.revision, updatedAt: now }, null, 2),
			"utf8",
		);
		await writeFile(
			join(backupPath, "deleted-cards-index.json"),
			JSON.stringify(
				pruned.map(({ card }) => ({
					id: card.id,
					title: card.title,
					agentId: card.agentId,
					agentSettings: card.agentSettings,
					role: card.role,
					createdAt: card.createdAt,
					updatedAt: card.updatedAt,
				})),
				null,
				1,
			),
			"utf8",
		);
		backedUp = true;
	}
	const summary = options.dryRun
		? `prune-done ${options.workspaceId}: ${doneCount} Done card(s), ${pruned.length} older than ${options.days} d would be deleted${kept.length ? ` (kept ${kept.length} runoff/calibration)` : ""}`
		: `prune-done ${options.workspaceId}: ${doneCount} Done card(s), deleted ${mutation.saved ? pruned.length : 0} older than ${options.days} d${kept.length ? ` (kept ${kept.length} runoff/calibration)` : ""}${backedUp ? `; backup ${backupPath}` : ""}`;
	return {
		doneCount,
		kept,
		pruned: pruned.map(({ id, title }) => ({ id, title })),
		backupPath: backedUp ? backupPath : null,
		dryRun: options.dryRun === true,
		summary,
	};
}
