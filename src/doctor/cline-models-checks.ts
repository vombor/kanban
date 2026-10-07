// Doctor row: do Cline's Lemonade models carry real context windows, or run on Cline's 128K default? Reads
// models.json only (never Lemonade), so it's fast and shows what Cline sees right now; `kanban setup` fills them in.
import { CLINE_DEFAULT_CONTEXT_WINDOW, readStoredModels, storedContextWindow } from "../setup/cline-lemonade-models";
import { readClineLemonadeEntry } from "../setup/cline-models-source";
import type { DoctorFinding } from "./doctor-report";

export async function checkClineLemonadeContextWindows(modelsPath: string): Promise<DoctorFinding[]> {
	const read = await readClineLemonadeEntry(modelsPath);
	if (read.kind !== "found") {
		// No Lemonade provider is nothing to check; an unreadable file is the setup rows' finding.
		return [];
	}
	const stored = readStoredModels(read.entry.models);
	const prefix = `cline lemonade models (${modelsPath})`;
	if (stored.form === "list") {
		return [
			{
				level: "warn",
				area: "setup",
				message: `${prefix}: \`models\` is a list, which cline 3.x rejects (it drops the provider), and no model carries a context window (${CLINE_DEFAULT_CONTEXT_WINDOW} default)`,
				hint: "kanban setup",
			},
		];
	}
	const entries = Object.entries(stored.models);
	if (entries.length === 0) {
		return [{ level: "info", area: "setup", message: `${prefix}: no models listed` }];
	}
	const withWindow = entries.flatMap(([id, entry]) => {
		const window = storedContextWindow(entry);
		return window === null ? [] : [`${id} ${window}`];
	});
	const withoutWindow = entries.filter(([, entry]) => storedContextWindow(entry) === null).map(([id]) => id);
	if (withoutWindow.length === 0) {
		return [{ level: "pass", area: "setup", message: `${prefix}: real context windows: ${withWindow.join(", ")}` }];
	}
	return [
		{
			level: "warn",
			area: "setup",
			message: `${prefix}: ${withoutWindow.length} of ${entries.length} on Cline's ${CLINE_DEFAULT_CONTEXT_WINDOW} default (${withoutWindow.join(", ")})${withWindow.length > 0 ? `; real: ${withWindow.join(", ")}` : ""}`,
			hint: "kanban setup",
		},
	];
}
