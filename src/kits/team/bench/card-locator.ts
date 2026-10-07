// Finds a card for card metrics by id or id prefix: the live boards first, then the newest board backup that has it
// (a card QA'd long ago may be Done and pruned). Read-only.
//
// Ported from archive/devteam-kit:bench/card-metrics.cjs@760fd36c (boardCard, repoOfWorkspace).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type RuntimeAgentId, type RuntimeBoardCard, runtimeBoardCardSchema } from "../../../core/api-contract";
import { getBoardBackupSearchDirs } from "../../../state/kanban-home";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceStateById,
	type RuntimeWorkspaceIndexEntry,
} from "../../../state/workspace-state";
import type { CardMetricsCard } from "./card-metrics";

const BOARD_BACKUP_FILE = /^board-\d{8}T\d{6}\.json$/u;
const BOARD_LATEST_FILE = "board-latest.json";

export interface LocatedCard {
	card: CardMetricsCard;
	/** The full board card, for role and title checks. */
	boardCard: RuntimeBoardCard;
	workspaceId: string;
	repoPath: string;
	/** "board" or the backup file the card was found in. */
	foundIn: string;
}

interface BackupBoardFile {
	columns?: Array<{ id?: string; cards?: unknown[] }>;
}

function matchesId(cardId: string, idOrPrefix: string): boolean {
	return cardId === idOrPrefix || cardId.startsWith(idOrPrefix);
}

function toMetricsCard(card: RuntimeBoardCard, column: string, sessionAgentId: RuntimeAgentId | null): CardMetricsCard {
	return {
		id: card.id,
		title: card.title ?? null,
		// The agent the session ran on wins over the card's own (plan §4.0).
		agentId: sessionAgentId ?? card.agentId ?? null,
		providerId: card.agentSettings?.providerId ?? null,
		modelId: card.agentSettings?.modelId ?? null,
		column,
	};
}

async function findInBackups(
	entry: RuntimeWorkspaceIndexEntry,
	idOrPrefix: string,
): Promise<Omit<LocatedCard, "workspaceId" | "repoPath"> | null> {
	for (const dir of getBoardBackupSearchDirs(entry.workspaceId)) {
		const names = await readdir(dir).catch(() => [] as string[]);
		const files = [
			...(names.includes(BOARD_LATEST_FILE) ? [BOARD_LATEST_FILE] : []),
			...names
				.filter((name) => BOARD_BACKUP_FILE.test(name))
				.sort()
				.reverse(),
		];
		for (const name of files) {
			let board: BackupBoardFile | null;
			try {
				board = JSON.parse(await readFile(join(dir, name), "utf8")) as BackupBoardFile | null;
			} catch {
				continue;
			}
			for (const column of board?.columns ?? []) {
				for (const raw of column.cards ?? []) {
					const parsed = runtimeBoardCardSchema.safeParse(raw);
					if (parsed.success && matchesId(parsed.data.id, idOrPrefix)) {
						return {
							card: toMetricsCard(parsed.data, column.id ?? "", null),
							boardCard: parsed.data,
							foundIn: join(dir, name),
						};
					}
				}
			}
		}
	}
	return null;
}

/** The card in `workspaceId` (or any registered workspace when null), live board first, then backups. */
export async function locateCard(idOrPrefix: string, workspaceId: string | null = null): Promise<LocatedCard | null> {
	const entries = (await listWorkspaceIndexEntries()).filter(
		(entry) => workspaceId === null || entry.workspaceId === workspaceId,
	);
	for (const entry of entries) {
		const state = await loadWorkspaceStateById(entry.workspaceId).catch(() => null);
		for (const column of state?.board.columns ?? []) {
			const card = column.cards.find((candidate) => matchesId(candidate.id, idOrPrefix));
			if (card) {
				return {
					card: toMetricsCard(card, column.id, state?.sessions[card.id]?.agentId ?? null),
					boardCard: card,
					workspaceId: entry.workspaceId,
					repoPath: entry.repoPath,
					foundIn: "board",
				};
			}
		}
	}
	for (const entry of entries) {
		const found = await findInBackups(entry, idOrPrefix);
		if (found) {
			return { ...found, workspaceId: entry.workspaceId, repoPath: entry.repoPath };
		}
	}
	return null;
}
