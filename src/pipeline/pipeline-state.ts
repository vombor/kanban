// The pipeline's per-card state: `data/<workspaceId>/pipeline-state.json` in the Kanban home (plan §1.1).
//
// It keeps the history a stage needs between evaluations (handled verdicts, FAIL rounds, reworks, handbacks), so
// the board card only carries what the UI shows. The per-card entries have the legacy kit's `checks-state.json`
// shape (`snapshot`, `version`, `harness`, `qaflow: { handled[], lastRound, failRounds[], reworks[], … }`,
// `qaCreated`, `qaCard`), kept as they are: the stages that read them (P4-2 … P4-6) own their fields.
//
// The first load of a workspace without a pipeline-state.json imports the legacy kit's checks-state.json once,
// read-only (the legacy kit may still be running on it until the cutover), and writes the result as
// pipeline-state.json. Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (updateState: a bare
// string entry predates CHECKS_VERSION and is just the checked snapshot; initQaflowSince: `_qaflow.since` is the
// go-live time, and verdicts older than it are never acted on, so a restart or an import doesn't act on old ones).
//
// A file a crash left empty or cut short (notes, 2026-10-11 ~17:14Z: 0 bytes after an unclean stop, and every
// evaluation of the workspace, restart recovery included, failed on "Unexpected end of JSON input"; issue #36) is
// read as no state: `peek` answers null, and the first write sets the damaged copy aside and starts a new state from
// now, without the legacy import (Kanban's state was the newer one) and with `since` now, so no verdict written
// before the loss is acted on again. A file that parses but isn't this version still refuses (never overwritten).
import { readFile, rename } from "node:fs/promises";
import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getLegacyKitChecksStatePaths, getPipelineStatePath } from "../state/kanban-home";

export const PIPELINE_STATE_VERSION = 1;

/** One card's entry. Open-ended on purpose: each stage owns its own fields. */
export const pipelineCardStateSchema = z.record(z.string(), z.unknown());
export type PipelineCardState = z.infer<typeof pipelineCardStateSchema>;

/** When the card was escalated (`qaflow.escalated.at`, written by the rework loop), or null; a handback clears it. */
export function readEscalatedAt(entry: PipelineCardState | undefined): string | null {
	const qaflow = entry?.qaflow;
	if (!qaflow || typeof qaflow !== "object" || Array.isArray(qaflow)) {
		return null;
	}
	const escalated = (qaflow as Record<string, unknown>).escalated;
	if (!escalated) {
		return null;
	}
	const at = typeof escalated === "object" ? (escalated as { at?: unknown }).at : undefined;
	return typeof at === "string" ? at : "(unknown time)";
}

export const pipelineWorkspaceStateSchema = z
	.object({
		version: z.literal(PIPELINE_STATE_VERSION),
		/** ISO time the pipeline started watching this workspace. Verdicts older than this are never acted on. */
		since: z.string(),
		/** The checks-state.json this state was imported from, or null. */
		importedFrom: z.string().nullable(),
		cards: z.record(z.string(), pipelineCardStateSchema),
	})
	.strict();
export type PipelineWorkspaceState = z.infer<typeof pipelineWorkspaceStateSchema>;

export interface PipelineStateStore {
	/** The workspace's state; imported from the legacy checks-state.json (or created) and saved on first use. */
	load: (workspaceId: string) => Promise<PipelineWorkspaceState>;
	/** The saved state, or null when there is none yet. Read-only: never creates or imports the file. */
	peek: (workspaceId: string) => Promise<PipelineWorkspaceState | null>;
	/** Read-modify-write under the state file's lock. */
	update: (
		workspaceId: string,
		mutate: (state: PipelineWorkspaceState) => PipelineWorkspaceState,
	) => Promise<PipelineWorkspaceState>;
}

export interface CreatePipelineStateStoreOptions {
	now?: () => number;
	getStatePath?: (workspaceId: string) => string;
	getLegacyChecksStatePaths?: (workspaceId: string) => string[];
	log?: (message: string) => void;
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readJsonIfExists(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isMissingFileError(error)) {
			return undefined;
		}
		throw error;
	}
}

async function readTextIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return null;
		}
		throw error;
	}
}

/** Why a state file is damaged (empty, or not JSON at all), or null when it is JSON. */
export function describeDamagedStateText(text: string): string | null {
	if (text.trim() === "") {
		return `empty (${Buffer.byteLength(text)} bytes)`;
	}
	try {
		JSON.parse(text);
		return null;
	} catch (error) {
		return `not JSON (${error instanceof Error ? error.message : String(error)})`;
	}
}

function damagedCopyStamp(at: number): string {
	return new Date(at)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Converts a legacy checks-state.json document. Keys starting with `_` are the kit's own bookkeeping
 * (`_qaflow.since`), not cards. Null when the document is not an object.
 */
export function importLegacyChecksState(
	raw: unknown,
	importedFrom: string,
	fallbackSince: string,
): PipelineWorkspaceState | null {
	if (!isPlainObject(raw)) {
		return null;
	}
	const qaflow = raw._qaflow;
	const since =
		isPlainObject(qaflow) && typeof qaflow.since === "string" && !Number.isNaN(Date.parse(qaflow.since))
			? qaflow.since
			: fallbackSince;
	const cards: Record<string, PipelineCardState> = {};
	for (const [taskId, entry] of Object.entries(raw)) {
		if (taskId.startsWith("_")) {
			continue;
		}
		if (typeof entry === "string") {
			cards[taskId] = { snapshot: entry };
		} else if (isPlainObject(entry)) {
			cards[taskId] = structuredClone(entry);
		}
	}
	return { version: PIPELINE_STATE_VERSION, since, importedFrom, cards };
}

export interface LegacyCardEntryChange {
	taskId: string;
	action: "added" | "updated";
	/** The keys the legacy entry changed (`qaflow.<key>` inside qaflow). */
	keys: string[];
}

export interface LegacyCardEntriesMerge {
	state: PipelineWorkspaceState;
	changes: LegacyCardEntryChange[];
	unchanged: string[];
	/** Legacy entries of cards that are Done, trashed or no longer on the board. */
	skipped: string[];
}

/**
 * The cutover's re-import (`kanban pipeline import-legacy`, P5-2): the legacy kit kept working on its
 * checks-state.json after the first import, so the entries of the cards still open (`openTaskIds`) are copied
 * again. The legacy kit owned those cards until now, so its keys win; keys only Kanban wrote are kept, inside
 * `qaflow` too. Merging the same file again changes nothing.
 */
export function mergeLegacyCardEntries(
	current: PipelineWorkspaceState,
	legacyCards: Record<string, PipelineCardState>,
	openTaskIds: ReadonlySet<string>,
): LegacyCardEntriesMerge {
	const cards = { ...current.cards };
	const changes: LegacyCardEntryChange[] = [];
	const unchanged: string[] = [];
	const skipped: string[] = [];
	for (const [taskId, legacy] of Object.entries(legacyCards)) {
		if (!openTaskIds.has(taskId)) {
			skipped.push(taskId);
			continue;
		}
		const existing = cards[taskId];
		const merged: PipelineCardState = { ...existing, ...structuredClone(legacy) };
		if (isPlainObject(existing?.qaflow) && isPlainObject(legacy.qaflow)) {
			merged.qaflow = { ...existing.qaflow, ...structuredClone(legacy.qaflow) };
		}
		const keys = changedKeys(existing ?? {}, merged);
		if (existing && keys.length === 0) {
			unchanged.push(taskId);
			continue;
		}
		cards[taskId] = merged;
		changes.push({ taskId, action: existing ? "updated" : "added", keys });
	}
	return { state: { ...current, cards }, changes, unchanged, skipped };
}

function changedKeys(before: PipelineCardState, after: PipelineCardState): string[] {
	const keys: string[] = [];
	for (const [key, value] of Object.entries(after)) {
		const previous = before[key];
		if (key === "qaflow" && isPlainObject(previous) && isPlainObject(value)) {
			keys.push(...changedKeys(previous, value).map((inner) => `qaflow.${inner}`));
		} else if (JSON.stringify(previous) !== JSON.stringify(value)) {
			keys.push(key);
		}
	}
	return keys;
}

export function createPipelineStateStore(options: CreatePipelineStateStoreOptions = {}): PipelineStateStore {
	const now = options.now ?? Date.now;
	const getStatePath = options.getStatePath ?? ((workspaceId: string) => getPipelineStatePath(workspaceId));
	const getLegacyPaths =
		options.getLegacyChecksStatePaths ?? ((workspaceId: string) => getLegacyKitChecksStatePaths(workspaceId));

	// path → the damage last logged for it, so a damaged file read on every evaluation is logged once.
	const loggedDamage = new Map<string, string>();

	type ReadResult = { state: PipelineWorkspaceState } | { damaged: string } | null;

	const readStateFile = async (workspaceId: string): Promise<ReadResult> => {
		const path = getStatePath(workspaceId);
		const text = await readTextIfExists(path);
		if (text === null) {
			return null;
		}
		const damaged = describeDamagedStateText(text);
		if (damaged) {
			if (loggedDamage.get(path) !== damaged) {
				loggedDamage.set(path, damaged);
				options.log?.(
					`pipeline ${workspaceId}: ${path} is ${damaged}, probably left by an unclean stop; read as no state until the next write replaces it`,
				);
			}
			return { damaged };
		}
		loggedDamage.delete(path);
		const parsed = pipelineWorkspaceStateSchema.safeParse(JSON.parse(text));
		if (!parsed.success) {
			// Never overwrite a file we can't read: a newer version or a hand edit would be lost.
			throw new Error(`${path} is not a version ${PIPELINE_STATE_VERSION} pipeline state: ${parsed.error.message}`);
		}
		return { state: parsed.data };
	};

	const readState = async (workspaceId: string): Promise<PipelineWorkspaceState | null> => {
		const result = await readStateFile(workspaceId);
		return result && "state" in result ? result.state : null;
	};

	/** A new state in place of a damaged file, which is kept next to it (an empty one is just replaced). */
	const replaceDamagedState = async (workspaceId: string, damaged: string): Promise<PipelineWorkspaceState> => {
		const path = getStatePath(workspaceId);
		const at = now();
		let kept = "";
		if (!damaged.startsWith("empty")) {
			const copy = `${path}.damaged-${damagedCopyStamp(at)}`;
			await rename(path, copy);
			kept = `; the damaged file is kept as ${copy}`;
		}
		const since = new Date(at).toISOString();
		options.log?.(
			`pipeline ${workspaceId}: ${path} was ${damaged}; started a new pipeline state (since ${since}, no legacy import): card history from before is gone, and verdicts written before now are not acted on${kept}`,
		);
		return { version: PIPELINE_STATE_VERSION, since, importedFrom: null, cards: {} };
	};

	const createInitialState = async (workspaceId: string): Promise<PipelineWorkspaceState> => {
		const fallbackSince = new Date(now()).toISOString();
		for (const legacyPath of getLegacyPaths(workspaceId)) {
			let raw: unknown;
			try {
				raw = await readJsonIfExists(legacyPath);
			} catch (error) {
				options.log?.(
					`pipeline ${workspaceId}: could not read ${legacyPath} (${error instanceof Error ? error.message : String(error)}); not imported`,
				);
				continue;
			}
			const imported = raw === undefined ? null : importLegacyChecksState(raw, legacyPath, fallbackSince);
			if (imported) {
				options.log?.(
					`pipeline ${workspaceId}: imported ${Object.keys(imported.cards).length} card entries from ${legacyPath} (since ${imported.since})`,
				);
				return imported;
			}
		}
		return { version: PIPELINE_STATE_VERSION, since: fallbackSince, importedFrom: null, cards: {} };
	};

	const update: PipelineStateStore["update"] = async (workspaceId, mutate) => {
		const path = getStatePath(workspaceId);
		return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
			const read = await readStateFile(workspaceId);
			const current =
				read === null
					? await createInitialState(workspaceId)
					: "damaged" in read
						? await replaceDamagedState(workspaceId, read.damaged)
						: read.state;
			const next = pipelineWorkspaceStateSchema.parse(mutate(structuredClone(current)));
			await lockedFileSystem.writeJsonFileAtomic(path, next, { lock: null });
			return next;
		});
	};

	return {
		load: async (workspaceId) => (await readState(workspaceId)) ?? (await update(workspaceId, (state) => state)),
		peek: readState,
		update,
	};
}
