// Doctor row: do Cline's Lemonade models (models.json) match what Lemonade reports now? Lists models to add or
// remove and changed context windows, vision and the rest, with the command the user runs to apply them (Kanban never
// writes Cline's files itself). Cheap: one catalog round to Lemonade (its requests in parallel, each capped at
// LEMONADE_TIMEOUT_MS), and Lemonade being down is INFO, not a failure.
import type { LemonadeModelListSettings } from "../config/model-lists-config";
import { formatApplyLemonadeModelsCommand } from "../setup/cline-lemonade-apply";
import { isLemonadeModelsDiffEmpty, planClineLemonadeModels } from "../setup/cline-lemonade-models";
import type { DoctorFinding } from "./doctor-report";

const LEMONADE_TIMEOUT_MS = 1_500;

export async function checkClineLemonadeModels(options: {
	modelsPath: string;
	/** Kanban server origin, for the printed command. */
	origin: string;
	lemonadeModelList: LemonadeModelListSettings;
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
	const message = `${prefix}: ${plan.details.join("; ")}`;
	if (!isLemonadeModelsDiffEmpty(plan.diff)) {
		return [{ level: "warn", area: "setup", message, hint: formatApplyLemonadeModelsCommand(options.origin) }];
	}
	if (plan.unreachable) {
		return [{ level: "info", area: "setup", message }];
	}
	return [{ level: "pass", area: "setup", message }];
}
