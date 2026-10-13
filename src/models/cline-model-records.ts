// Cline's models.json records: a provider entry with a `models` record offers only those models, so the record is
// Cline's allow list (docs/team/MODELS.md). Read by doctor's allow-list row and the settings dialog's Cline model
// select; Kanban never writes it from here.
import { readFile } from "node:fs/promises";

import { readStoredModels } from "../setup/cline-lemonade-models";

/** The model ids of every provider entry in models.json that has a `models` record; null when there is no file. */
export async function readClineModelRecords(modelsPath: string): Promise<Map<string, Set<string>> | null> {
	let document: unknown;
	try {
		document = JSON.parse(await readFile(modelsPath, "utf8"));
	} catch {
		// No file, or one the setup rows already report as unreadable.
		return null;
	}
	const providers =
		document && typeof document === "object" ? (document as { providers?: unknown }).providers : undefined;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		return null;
	}
	const records = new Map<string, Set<string>>();
	for (const [providerId, entry] of Object.entries(providers as Record<string, unknown>)) {
		if (entry && typeof entry === "object" && "models" in entry) {
			records.set(providerId, new Set(Object.keys(readStoredModels((entry as { models: unknown }).models).models)));
		}
	}
	return records;
}
