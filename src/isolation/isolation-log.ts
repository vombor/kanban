// `<home>/data/<ws>/isolation.jsonl`: one JSON line per isolation event of the workspace's sessions (a reach outside
// the project refused or reported, a refused project change, a grant made, used or revoked, a child credential
// bound). A grant and its uses are written on both sides: the session's workspace and the one it reaches.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { getIsolationWorkspacePaths } from "../state/kanban-home";

export type IsolationLogKind =
	| "refused"
	| "reported"
	| "project_change_refused"
	| "grant"
	| "grant_used"
	| "grant_revoked"
	| "message_refused"
	| "mode_changed"
	| "approval"
	| "child_credential";

export interface IsolationLogRecord {
	at: string;
	kind: IsolationLogKind;
	/** The session (`<task id>` or the orchestrator's session id), or null for the user. */
	taskId: string | null;
	/** The workspace whose session acted. */
	fromWorkspaceId: string | null;
	/** The workspace it reached, when another one. */
	toWorkspaceId: string | null;
	/** What was attempted: a tRPC path, a CLI command, `launch`. */
	action: string;
	detail: string;
}

export type IsolationLogWriter = (workspaceId: string, record: IsolationLogRecord) => Promise<void>;

export const appendIsolationLog: IsolationLogWriter = async (workspaceId, record) => {
	const path = getIsolationWorkspacePaths(workspaceId).log;
	try {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Best effort: a log write never decides an access.
	}
};
