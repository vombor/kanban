// Doctor row: do Cline's Lemonade models (models.json) match what Lemonade reports now? Lists models to add or
// remove and changed context windows, vision and the rest, with the command the user runs to apply them. Of those,
// the server's Lemonade context sync (`agents.cline.lemonadeContextSync`, issue #31) writes the context windows
// itself; the row says what it will do, or that it is off, so a difference that stays means the sync is off or
// failed (its history: `<home>/data/models/cline-lemonade-sync.jsonl`). Cheap: one catalog round to Lemonade (its
// requests in parallel, each capped at LEMONADE_TIMEOUT_MS), and Lemonade being down is INFO, not a failure.
import {
	CLINE_LEMONADE_CONTEXT_SYNC_KEY,
	type ClineLemonadeContextSyncSettings,
} from "../config/cline-lemonade-context-sync-config";
import type { LemonadeModelListSettings } from "../config/model-lists-config";
import { formatApplyLemonadeModelsCommand } from "../setup/cline-lemonade-apply";
import { planLemonadeContextSync } from "../setup/cline-lemonade-context-sync";
import {
	isLemonadeModelsDiffEmpty,
	type LemonadeModelsPlan,
	planClineLemonadeModels,
} from "../setup/cline-lemonade-models";
import { getClineLemonadeSyncHistoryPath } from "../state/kanban-home";
import type { DoctorFinding } from "./doctor-report";

const LEMONADE_TIMEOUT_MS = 1_500;

function describeContextSync(
	plan: LemonadeModelsPlan,
	contextSync: Pick<ClineLemonadeContextSyncSettings, "mode" | "intervalSec">,
	historyPath: string,
): string[] {
	const sync = planLemonadeContextSync(plan);
	if (sync.changes.length === 0) {
		return [];
	}
	const models = sync.changes.map((change) => change.id).join(", ");
	if (contextSync.mode === "on") {
		return [
			`the server's Lemonade context sync writes the context windows of ${models} within ${contextSync.intervalSec}s or before the next Cline launch; if they stay, see ${historyPath}`,
		];
	}
	return [
		`the Lemonade context sync is ${contextSync.mode} (${CLINE_LEMONADE_CONTEXT_SYNC_KEY}.mode), so the context windows of ${models} change only with the command`,
	];
}

export async function checkClineLemonadeModels(options: {
	modelsPath: string;
	/** Kanban server origin, for the printed command. */
	origin: string;
	lemonadeModelList: LemonadeModelListSettings;
	/** The server's context sync settings; without them the row doesn't mention the sync. */
	contextSync?: Pick<ClineLemonadeContextSyncSettings, "mode" | "intervalSec">;
	historyPath?: string;
	fetch?: typeof fetch;
}): Promise<DoctorFinding[]> {
	const plan = await planClineLemonadeModels({
		modelsPath: options.modelsPath,
		requireLabels: options.lemonadeModelList.requireLabels,
		lemonadeUrl: options.lemonadeModelList.url,
		fetch: options.fetch,
		timeoutMs: LEMONADE_TIMEOUT_MS,
	});
	if (plan.kind !== "found") {
		// No Lemonade provider is nothing to check; an unreadable file is the setup rows' finding.
		return [];
	}
	const prefix = `cline lemonade models (${options.modelsPath})`;
	if (!isLemonadeModelsDiffEmpty(plan.diff)) {
		const sync = options.contextSync
			? describeContextSync(plan, options.contextSync, options.historyPath ?? getClineLemonadeSyncHistoryPath())
			: [];
		return [
			{
				level: "warn",
				area: "setup",
				message: `${prefix}: ${[...plan.details, ...sync].join("; ")}`,
				hint: formatApplyLemonadeModelsCommand(options.origin),
			},
		];
	}
	const message = `${prefix}: ${plan.details.join("; ")}`;
	if (plan.unreachable) {
		return [{ level: "info", area: "setup", message }];
	}
	return [{ level: "pass", area: "setup", message }];
}
