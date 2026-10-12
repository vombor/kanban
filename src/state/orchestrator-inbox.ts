// A workspace's orchestrator inbox (`<home>/data/<ws>/orchestrator-inbox.jsonl`): watchdog wakes queued silently
// while the user works in the orchestrator sidebar, instead of typed into it as a new prompt. One JSON line per wake,
// tagged with the workspace it is about (like the headless queue's `[<ws>]` tags, docs/fork/watchdog-isolation.md);
// lines tagged with another workspace are never handed out and are dropped on the next write.
//
// Only the server reads and writes it (src/server/orchestrator-inbox.ts): the watchdog's `queueOrchestratorNotices`
// request appends, the sidebar's prompt hook takes everything through tRPC `orchestratorInbox.take`, and what is still
// unread at `typeAfter` is taken and typed into the sidebar as a wake.
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getWatchdogWorkspacePaths } from "./kanban-home";

const entrySchema = z.object({
	workspaceId: z.string(),
	/** The sidebar session the wake was for (createHomeAgentSessionId). */
	taskId: z.string(),
	at: z.string(),
	/** Typed into the sidebar if no prompt has taken it by then (`orchestrator.wake.quietMin` after `at`). */
	typeAfter: z.string(),
	items: z.array(z.string()),
	/** The wake text the watchdog would have typed (buildWakeText). */
	text: z.string(),
});
export type OrchestratorInboxEntry = z.infer<typeof entrySchema>;

export function getOrchestratorInboxPath(workspaceId: string, homePath?: string): string {
	return getWatchdogWorkspacePaths(workspaceId, homePath).orchestratorInbox;
}

/** The entries tagged with `workspaceId`; unreadable lines and other workspaces' lines are skipped. */
export function parseOrchestratorInbox(text: string, workspaceId: string): OrchestratorInboxEntry[] {
	const entries: OrchestratorInboxEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		try {
			const parsed = entrySchema.safeParse(JSON.parse(line));
			if (parsed.success && parsed.data.workspaceId === workspaceId) {
				entries.push(parsed.data);
			}
		} catch {
			// a torn line: skipped
		}
	}
	return entries;
}

async function readText(path: string): Promise<string> {
	return await readFile(path, "utf8").catch(() => "");
}

export async function readOrchestratorInbox(path: string, workspaceId: string): Promise<OrchestratorInboxEntry[]> {
	return parseOrchestratorInbox(await readText(path), workspaceId);
}

/**
 * Changes the workspace's entries under the file's lock and writes them back (durably; no entries = no file).
 * Returns what `change` returns.
 */
export async function updateOrchestratorInbox<T>(
	path: string,
	workspaceId: string,
	change: (entries: OrchestratorInboxEntry[]) => { entries: OrchestratorInboxEntry[]; result: T },
): Promise<T> {
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const text = await readText(path);
		const { entries, result } = change(parseOrchestratorInbox(text, workspaceId));
		if (entries.length === 0) {
			if (text) {
				await rm(path, { force: true });
			}
			return result;
		}
		await lockedFileSystem.writeTextFileAtomic(
			path,
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			{
				lock: null,
			},
		);
		return result;
	});
}

/** The text the sidebar's prompt hook hands the model with the user's prompt (Claude Code `additionalContext`). */
export function formatOrchestratorNotices(entries: readonly OrchestratorInboxEntry[]): string | null {
	if (entries.length === 0) {
		return null;
	}
	return [
		"Kanban notices since your last turn (queued by Kanban's watchdog while the user was working in this sidebar, so they were not typed as a prompt; the user did not write them and may not have read them):",
		...entries.map((entry) => `- ${entry.text}`),
		"Answer the user's message first, then handle these as you would a typed wake.",
	].join("\n");
}
