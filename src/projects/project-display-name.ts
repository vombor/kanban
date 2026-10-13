// A project's display name (`workspaces.<id>.name` in config.json, issue #43): what the project list, doctor and the
// scoreboard call the project instead of its directory name. It changes only through the server's route
// (src/trpc/project-name-api.ts: the user and that project's own orchestrator), which `kanban project rename` and the
// browser's project menu call; every change is a line in `<home>/data/<ws>/project-name-history.jsonl`.
//
// The project list reaches every client, agent sessions of other projects included, so a name the project's own
// orchestrator wrote must not carry instructions or markup there: a name is one short line of letters, digits, spaces
// and a few punctuation marks (`PROJECT_DISPLAY_NAME_PATTERN`), and the list shows a stored name only when it still
// fits that rule (a hand-edited one that doesn't is shown as the directory name).
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { updateWorkspacePipelineEntry } from "../config/pipeline-config";
import { getProjectNameHistoryPath } from "../state/kanban-home";

export const PROJECT_DISPLAY_NAME_MAX_LENGTH = 40;
const PROJECT_DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._'&()+-]*[\p{L}\p{N}.')])?$/u;

export type ProjectDisplayNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** The name as stored (trimmed, inner runs of spaces made one), or why it can't be one. */
export function checkProjectDisplayName(raw: string): ProjectDisplayNameCheck {
	const name = raw.trim().replace(/ {2,}/g, " ");
	if (name.length === 0) {
		return { ok: false, error: "The project name is empty." };
	}
	if (name.length > PROJECT_DISPLAY_NAME_MAX_LENGTH) {
		return {
			ok: false,
			error: `The project name is ${name.length} characters long; at most ${PROJECT_DISPLAY_NAME_MAX_LENGTH} are allowed.`,
		};
	}
	if (!PROJECT_DISPLAY_NAME_PATTERN.test(name)) {
		return {
			ok: false,
			error: "A project name is one line of letters, digits, spaces and . _ - ' & ( ) +, starting with a letter or digit.",
		};
	}
	return { ok: true, name };
}

/** A stored name the project list may show, else null (the list then shows the directory name). */
export function readShowableProjectDisplayName(stored: string | null | undefined): string | null {
	if (typeof stored !== "string") {
		return null;
	}
	const check = checkProjectDisplayName(stored);
	return check.ok && check.name === stored ? check.name : null;
}

export interface ProjectNameHistoryEntry {
	at: string;
	workspaceId: string;
	from: string | null;
	to: string | null;
	/** Who asked: "user" or "orchestrator <taskId>". */
	by: string;
}

export interface SetProjectDisplayNameInput {
	workspaceId: string;
	/** The new name, or null to drop it (the directory name is shown again). */
	name: string | null;
	by: string;
	configPath?: string;
	homePath?: string;
	now?: () => number;
}

export interface ProjectDisplayNameChange {
	workspaceId: string;
	name: string | null;
	previous: string | null;
	/** False when the name already was the asked one (nothing written). */
	changed: boolean;
}

/** Sets or drops the project's display name under the config lock, and logs a change (none when unchanged). */
export async function setProjectDisplayName(input: SetProjectDisplayNameInput): Promise<ProjectDisplayNameChange> {
	let name: string | null = null;
	if (input.name !== null) {
		const check = checkProjectDisplayName(input.name);
		if (!check.ok) {
			throw new Error(check.error);
		}
		name = check.name;
	}
	let previous: string | null = null;
	let changed = false;
	await updateWorkspacePipelineEntry(
		input.workspaceId,
		(entry) => {
			previous = typeof entry.name === "string" ? entry.name : null;
			if (previous === name) {
				return Object.keys(entry).length > 0 ? entry : null;
			}
			changed = true;
			if (name === null) {
				delete entry.name;
				// A workspace whose entry held only its name has none afterwards.
				return Object.keys(entry).length > 0 ? entry : null;
			}
			return { ...entry, name };
		},
		input.configPath,
	);
	if (changed) {
		const historyEntry: ProjectNameHistoryEntry = {
			at: new Date((input.now ?? Date.now)()).toISOString(),
			workspaceId: input.workspaceId,
			from: previous,
			to: name,
			by: input.by,
		};
		const path = getProjectNameHistoryPath(input.workspaceId, input.homePath);
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(historyEntry)}\n`, "utf8");
	}
	return { workspaceId: input.workspaceId, name, previous, changed };
}
