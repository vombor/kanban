// Who moved each card to Done or deleted it, and what that did (`<home>/data/<workspaceId>/task-history.jsonl`).
// At the 2026-10-07 restart two of foo's QA cards ended in Done with nothing in any log saying who moved them; every
// Done move now leaves one line here, written by its one implementation (src/server/task-trash-workflow.ts), and so
// does every delete (the `workspace.deleteWorktree` route, prune-done). Read with `kanban task history [<id>]`.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
	type RuntimeTaskHistoryCaller,
	type RuntimeTaskHistoryEntry,
	runtimeTaskHistoryEntrySchema,
} from "../core/api-contract";
import type { RuntimeCaller } from "../isolation/session-identity";
import { getTaskHistoryLogPath } from "./kanban-home";

export type TaskHistoryEntry = RuntimeTaskHistoryEntry;

export function toTaskHistoryCaller(caller: RuntimeCaller): RuntimeTaskHistoryCaller {
	if (caller.kind !== "session") {
		return caller;
	}
	return {
		kind: "session",
		workspaceId: caller.session.workspaceId,
		taskId: caller.session.taskId,
		role: caller.session.role,
		agentId: caller.session.agentId,
		via: caller.via,
	};
}

/**
 * Starts the caller lookup right away and never rejects (a failed lookup is `unknown`). Callers start it before
 * they stop any session: the strict lookup traces the calling process through /proc, and a card session that
 * finishes its own card has no process left afterwards. Without `resolveCaller` (in-process triggers): null.
 */
export function startTaskHistoryCallerLookup(
	resolveCaller: (() => Promise<RuntimeCaller>) | undefined,
): Promise<RuntimeTaskHistoryCaller | null> {
	if (!resolveCaller) {
		return Promise.resolve(null);
	}
	return resolveCaller().then(toTaskHistoryCaller, (error: unknown) => ({
		kind: "unknown",
		reason: `the caller lookup failed: ${error instanceof Error ? error.message : String(error)}`,
	}));
}

/** Appends one entry to its workspace's history. */
export async function appendTaskHistory(entry: TaskHistoryEntry, options: { homePath?: string } = {}): Promise<void> {
	const path = getTaskHistoryLogPath(entry.workspaceId, options.homePath);
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/** The workspace's entries, oldest first (only `taskId`'s when given; the newest `limit`). Bad lines are skipped. */
export async function readTaskHistory(
	workspaceId: string,
	options: { taskId?: string; limit?: number; homePath?: string } = {},
): Promise<{ path: string; entries: TaskHistoryEntry[] }> {
	const path = getTaskHistoryLogPath(workspaceId, options.homePath);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path, entries: [] };
		}
		throw error;
	}
	const entries: TaskHistoryEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		const parsed = runtimeTaskHistoryEntrySchema.safeParse(value);
		if (parsed.success && (!options.taskId || parsed.data.taskId === options.taskId)) {
			entries.push(parsed.data);
		}
	}
	return { path, entries: options.limit ? entries.slice(-options.limit) : entries };
}
