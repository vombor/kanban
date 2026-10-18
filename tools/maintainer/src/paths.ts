import { join } from "node:path";
import { getKanbanDataPath } from "../../../src/state/kanban-home";

export function getMaintenancePaths(home?: string) {
	const root = join(getKanbanDataPath(home), "host-maintenance");
	return { root, journal: join(root, "journal.json"), jobDirectory: (id: string) => join(root, "jobs", id) };
}
