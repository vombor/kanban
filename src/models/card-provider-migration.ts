// `kanban models providers --migrate-cards`: move open cards off a deprecated provider onto the provider the
// policy gives their model, keeping the model. Only the provider id changes; a running card picks it up on its
// next start.
//
// Ported from archive/devteam-kit:bin/providers.mjs@6b61bfe (--migrate-cards: backlog / in progress / review
// cards whose provider is in `providers.deprecated`, same model, `task update --cline-provider`).
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../core/api-contract";
import { deprecatedProviderIds, type ProvidersPolicy, providerForModel } from "./cline-providers";

const MIGRATED_COLUMNS: ReadonlySet<RuntimeBoardColumnId> = new Set(["backlog", "in_progress", "review"]);

export interface CardProviderMigration {
	taskId: string;
	column: RuntimeBoardColumnId;
	model: string;
	from: string;
	to: string;
}

function migrationFor(
	card: RuntimeBoardCard,
	column: RuntimeBoardColumnId,
	deprecated: ReadonlySet<string>,
	policy: ProvidersPolicy,
): CardProviderMigration | null {
	const from = card.agentSettings?.providerId?.trim();
	const model = card.agentSettings?.modelId?.trim();
	if (!from || !model || !deprecated.has(from)) {
		return null;
	}
	const to = providerForModel(model, policy);
	return to === from ? null : { taskId: card.id, column, model, from, to };
}

export function planCardProviderMigrations(board: RuntimeBoardData, policy: ProvidersPolicy): CardProviderMigration[] {
	const deprecated = deprecatedProviderIds(policy);
	const migrations: CardProviderMigration[] = [];
	for (const column of board.columns) {
		if (!MIGRATED_COLUMNS.has(column.id)) {
			continue;
		}
		for (const card of column.cards) {
			const migration = migrationFor(card, column.id, deprecated, policy);
			if (migration) {
				migrations.push(migration);
			}
		}
	}
	return migrations;
}

/** The board with every planned card moved to its new provider (model and reasoning effort unchanged). */
export function applyCardProviderMigrations(
	board: RuntimeBoardData,
	migrations: readonly CardProviderMigration[],
	now: number = Date.now(),
): RuntimeBoardData {
	const byTaskId = new Map(migrations.map((migration) => [migration.taskId, migration]));
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => {
				const migration = byTaskId.get(card.id);
				return migration
					? { ...card, agentSettings: { ...card.agentSettings, providerId: migration.to }, updatedAt: now }
					: card;
			}),
		})),
	};
}
