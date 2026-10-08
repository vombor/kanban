// Issue import's bookkeeping per workspace (getIssueWorkspacePaths): `issues-state.json` and the provider's HTTP cache.
// The sync (worker job or CLI) writes the cursor, the backoff, the skipped list and the last sync; the apply step
// (server or CLI, under the board lock) writes the imported records. Every write is a locked read-modify-write, so
// the two never lose each other's changes.
//
// A missing file starts empty. A file that exists but can't be parsed is never overwritten: it holds the import
// records that keep Done and pruned cards deduped, so it is copied to `issues-state.json.corrupt` and every sync,
// apply and `kanban issues list` refuses (IssueStateCorruptError, a doctor fail) until the user fixes or removes it.
import { copyFile, readFile } from "node:fs/promises";
import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import type { IssueHttpCacheEntry } from "./github-provider";

/** HTTP cache entries unused this long are dropped on save. */
const HTTP_CACHE_KEEP_MS = 14 * 24 * 60 * 60_000;
const HTTP_CACHE_MAX_ENTRIES = 2_000;
/** Skipped issues are kept for `kanban issues list` this long after they were last seen. */
const SKIPPED_KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_WAKE_NOTES = 50;

export const importedIssueRecordSchema = z.object({
	number: z.number().int().positive(),
	repo: z.string(),
	provider: z.literal("github"),
	taskId: z.string(),
	importedAt: z.string(),
	/** The issue's `updated_at` the last sync handled. */
	seenUpdatedAt: z.string(),
	title: z.string(),
	bodySha: z.string(),
	commentIds: z.array(z.number()).default([]),
	closed: z.boolean().default(false),
	plan: z.boolean().default(false),
});
export type ImportedIssueRecord = z.infer<typeof importedIssueRecordSchema>;

export const skippedIssueRecordSchema = z.object({
	number: z.number().int().positive(),
	title: z.string(),
	reason: z.string(),
	detail: z.string(),
	at: z.string(),
	updatedAt: z.string(),
});
export type SkippedIssueRecord = z.infer<typeof skippedIssueRecordSchema>;

export const issueLastSyncSchema = z.object({
	at: z.string(),
	ok: z.boolean(),
	mode: z.string(),
	repo: z.string().nullable(),
	authSource: z.string().nullable(),
	summary: z.string(),
	error: z.string().nullable().default(null),
	created: z.number().int().nonnegative().default(0),
	updated: z.number().int().nonnegative().default(0),
	closed: z.number().int().nonnegative().default(0),
	skipped: z.record(z.string(), z.number()).default({}),
});
export type IssueLastSync = z.infer<typeof issueLastSyncSchema>;

export const pinnedIssueRepoSchema = z.object({
	provider: z.literal("github"),
	repo: z.string(),
	at: z.string(),
	/** `origin`: derived from the origin remote on the first sync; `config`: the user's `issues.repo`. */
	source: z.enum(["origin", "config"]),
});
export type PinnedIssueRepo = z.infer<typeof pinnedIssueRepoSchema>;

export const issueSyncStateSchema = z.object({
	version: z.literal(1).default(1),
	/**
	 * The repository the first sync resolved. Worktrees share `.git/config`, so a card could point `origin` elsewhere;
	 * a derived repository that no longer matches the pin is refused until the user sets `issues.repo`.
	 */
	pinnedRepo: pinnedIssueRepoSchema.nullable().default(null),
	/** Report mode: the `updated_at` each not-yet-imported issue had when its comments were last fetched. */
	reportSeen: z.record(z.string(), z.string()).default({}),
	/** What the cursor is for (provider, repo and filter); a change starts a full scan of the open issues. */
	sourceKey: z.string().nullable().default(null),
	/** The newest `updated_at` seen: the next list asks `since` it, so an unchanged repository answers 304. */
	since: z.string().nullable().default(null),
	backoff: z
		.object({ until: z.string().nullable().default(null), step: z.number().int().nonnegative().default(0) })
		.default({ until: null, step: 0 }),
	lastSync: issueLastSyncSchema.nullable().default(null),
	/** By issueKey(). */
	issues: z.record(z.string(), importedIssueRecordSchema).default({}),
	skipped: z.record(z.string(), skippedIssueRecordSchema).default({}),
	/** Updates of started cards' issues, for the orchestrator's next wake (the watchdog takes them). */
	wakeNotes: z.array(z.string()).default([]),
});
export type IssueSyncState = z.infer<typeof issueSyncStateSchema>;

export function createEmptyIssueSyncState(): IssueSyncState {
	return issueSyncStateSchema.parse({});
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

export class IssueStateCorruptError extends Error {
	readonly backupPath: string;

	constructor(path: string, backupPath: string, detail: string) {
		super(
			`${path} can't be read (${detail}); it was copied to ${backupPath}. Issue import refuses to run until the file is fixed or removed (removing it forgets which issues were imported, so Done and pruned cards may be imported again).`,
		);
		this.name = "IssueStateCorruptError";
		this.backupPath = backupPath;
	}
}

async function copyOnce(from: string, to: string): Promise<void> {
	await copyFile(from, to, 1 /* COPYFILE_EXCL: keep the first copy */).catch(() => {});
}

/** The state; empty when the file is missing. Throws IssueStateCorruptError (after a backup) when it can't be parsed. */
export async function readIssueSyncState(path: string): Promise<IssueSyncState> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return createEmptyIssueSyncState();
		}
		throw error;
	}
	let detail: string;
	try {
		const parsed = issueSyncStateSchema.safeParse(JSON.parse(text));
		if (parsed.success) {
			return parsed.data;
		}
		detail = parsed.error.issues[0]?.message ?? "invalid";
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
	}
	const backupPath = `${path}.corrupt`;
	await copyOnce(path, backupPath);
	throw new IssueStateCorruptError(path, backupPath, detail);
}

function pruneSkipped(state: IssueSyncState, now: number): IssueSyncState {
	return {
		...state,
		skipped: Object.fromEntries(
			Object.entries(state.skipped).filter(([, entry]) => now - Date.parse(entry.at) < SKIPPED_KEEP_MS),
		),
		wakeNotes: state.wakeNotes.slice(-MAX_WAKE_NOTES),
	};
}

/**
 * Read-modify-write of issues-state.json under its lock; `update` may be async (the apply step runs its board
 * mutation inside, so two applies never plan against the same records).
 */
export async function withIssueSyncState<T>(
	path: string,
	update: (state: IssueSyncState) => Promise<{ state: IssueSyncState; value: T }>,
	now: () => number = Date.now,
): Promise<T> {
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const result = await update(await readIssueSyncState(path));
		await lockedFileSystem.writeJsonFileAtomic(path, pruneSkipped(result.state, now()), { lock: null });
		return result.value;
	});
}

/** Read-modify-write of issues-state.json under its lock. */
export async function updateIssueSyncState<T>(
	path: string,
	update: (state: IssueSyncState) => { state: IssueSyncState; value: T },
	now: number = Date.now(),
): Promise<T> {
	return await withIssueSyncState(
		path,
		async (state) => update(state),
		() => now,
	);
}

/** Takes (and clears) the wake notes; the watchdog calls this when it wakes the orchestrator anyway. */
export async function takeIssueWakeNotes(path: string): Promise<string[]> {
	const current = await readIssueSyncState(path);
	if (current.wakeNotes.length === 0) {
		return [];
	}
	return await updateIssueSyncState(path, (state) => ({
		state: { ...state, wakeNotes: [] },
		value: state.wakeNotes,
	}));
}

const httpCacheSchema = z.object({
	version: z.literal(1),
	entries: z.record(
		z.string(),
		z.object({ etag: z.string(), body: z.unknown(), at: z.string(), next: z.string().nullable().optional() }),
	),
});

export async function readIssueHttpCache(path: string): Promise<Record<string, IssueHttpCacheEntry>> {
	const parsed = httpCacheSchema.safeParse(await readJson(path));
	return parsed.success ? (parsed.data.entries as Record<string, IssueHttpCacheEntry>) : {};
}

export async function writeIssueHttpCache(
	path: string,
	entries: Record<string, IssueHttpCacheEntry>,
	now: number = Date.now(),
): Promise<void> {
	const kept = Object.entries(entries)
		.filter(([, entry]) => now - Date.parse(entry.at) < HTTP_CACHE_KEEP_MS)
		.sort(([, left], [, right]) => Date.parse(right.at) - Date.parse(left.at))
		.slice(0, HTTP_CACHE_MAX_ENTRIES);
	await lockedFileSystem.writeJsonFileAtomic(path, { version: 1, entries: Object.fromEntries(kept) });
}
