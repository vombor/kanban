// The team kit's runoff groups: `<home>/data/<workspaceId>/runoffs.json`, in the legacy kit's format
// (`{ "runoffs": [{ name, cards[], models, base, prompt, createdAt, benchOnly?, decided, winner, results[] }] }`), so
// the orchestrator's notes, prune-done and the watchdog read the same file before and after the cutover.
// `kanban bench runoff create` adds a group; the `runoffs` feature (runoffs-feature.ts) decides it.
//
// Entries keep every field they had (`reopened[]`, `abandoned`, hand-written notes): the schema only checks the keys
// this code reads. An entry that does not parse is left in the file untouched and ignored.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (readRunoffs, runoffOf) and bin/kit@6da71597
// (handback: a runoff decided with no winner reopens, 158817d).
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { lockedFileSystem } from "../../../fs/locked-file-system";

export const runoffResultSchema = z
	.object({
		id: z.string(),
		/** `pass`: a held PASS for its current snapshot; `done`/`gone`: trashed or deleted by hand. */
		out: z.enum(["pass", "escalated", "done", "gone"]),
		snapshot: z.string().optional(),
		round: z.number().optional(),
		ts: z.string().optional(),
		model: z.string().nullable().optional(),
		score: z.number().optional(),
		fails: z.number().optional(),
		cost: z.number().nullable().optional(),
		/** A card trashed by hand that held a runoff PASS. */
		passed: z.boolean().optional(),
	})
	.passthrough();
export type RunoffResult = z.infer<typeof runoffResultSchema>;

export const runoffEntrySchema = z
	.object({
		name: z.string().min(1),
		cards: z.array(z.string()),
		/** taskId → "provider/model" (or just the model), as the creator wrote it. */
		models: z.record(z.string(), z.string()).optional(),
		base: z.string().optional(),
		prompt: z.string().optional(),
		createdAt: z.string().optional(),
		/** A re-run on a base that already has the work: nothing lands, every PASS is preserved (2ffe609). */
		benchOnly: z.boolean().optional(),
		abandoned: z.unknown().optional(),
		decided: z.string().nullable().optional(),
		winner: z.string().nullable().optional(),
		results: z.array(runoffResultSchema).optional(),
		note: z.string().optional(),
	})
	.passthrough();
export type RunoffEntry = z.infer<typeof runoffEntrySchema>;

export interface RunoffsFile {
	/** The entries that parse, in file order. */
	runoffs: RunoffEntry[];
	/** Problems with entries that don't (kept in the file as they are). */
	issues: string[];
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readRaw(path: string): Promise<unknown[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return [];
		}
		throw error;
	}
	const document = JSON.parse(text) as unknown;
	const runoffs = document && typeof document === "object" ? (document as { runoffs?: unknown }).runoffs : undefined;
	if (!Array.isArray(runoffs)) {
		throw new Error(`${path}: expected { "runoffs": [...] }`);
	}
	return runoffs;
}

function parseEntries(raw: unknown[]): Array<{ index: number; entry: RunoffEntry } | { index: number; issue: string }> {
	return raw.map((value, index) => {
		const parsed = runoffEntrySchema.safeParse(value);
		return parsed.success
			? { index, entry: parsed.data }
			: { index, issue: `runoffs[${index}]: ${parsed.error.issues[0]?.message ?? "invalid"}` };
	});
}

export async function readRunoffs(path: string): Promise<RunoffsFile> {
	const parsed = parseEntries(await readRaw(path));
	return {
		runoffs: parsed.flatMap((item) => ("entry" in item ? [item.entry] : [])),
		issues: parsed.flatMap((item) => ("issue" in item ? [item.issue] : [])),
	};
}

/** Open = not decided and not abandoned: its cards' PASSes are held. */
export function isOpenRunoff(runoff: RunoffEntry): boolean {
	return !runoff.decided && !runoff.abandoned;
}

/** The open runoff a card races in, or null. */
export function findOpenRunoff(runoffs: readonly RunoffEntry[], taskId: string): RunoffEntry | null {
	return runoffs.find((runoff) => isOpenRunoff(runoff) && runoff.cards.includes(taskId)) ?? null;
}

/**
 * The decided runoff in which a card must never land, or null: one whose winner is another card, or a bench-only one
 * (nothing lands). A decided runoff's landing winner is not barred: a land that conflicted sends it back through
 * rework and QA, and its next PASS lands like any card's (6f756 in tier2-promos, 10/08). A runoff decided with no
 * winner bars nothing (handback reopens it). The decision is final: a winner discarded later lets no runner-up land;
 * a loser's work is used through a new card from its `preserve/<id>-<model>` tag.
 */
export function findRunoffBarringLand(runoffs: readonly RunoffEntry[], taskId: string): RunoffEntry | null {
	return (
		runoffs.find(
			(runoff) =>
				runoff.cards.includes(taskId) &&
				Boolean(runoff.decided) &&
				(runoff.benchOnly === true || (Boolean(runoff.winner) && runoff.winner !== taskId)),
		) ?? null
	);
}

/** "decided (winner X)" / "decided (bench only, nothing lands)", for a runoff `findRunoffBarringLand` returned. */
export function describeRunoffLandBar(runoff: RunoffEntry): string {
	return `decided (${runoff.benchOnly === true ? "bench only, nothing lands" : `winner ${runoff.winner}`})`;
}

/**
 * The way out for a card a decided runoff bars from landing. A held card can only be discarded through
 * release-hold (the landing gate refuses a plain Done of a held card). The decision is final, even if the winner is
 * discarded later, so a loser's work is used through a new card.
 */
export function describeRunoffLoserWayOut(taskId: string, held: boolean): string {
	const discard = held
		? `kanban task release-hold --task-id ${taskId} --discard`
		: `kanban task done --task-id ${taskId} --discard`;
	return `The runoff's decision is final: discard it (${discard}), and to use its work, start a new card from its preserve/${taskId}-<model> tag.`;
}

/**
 * Read-modify-write under the file's lock. `mutate` gets the entries that parse (and may append new ones); the
 * entries that don't parse are written back where they were.
 */
export async function updateRunoffs<T>(
	path: string,
	mutate: (runoffs: RunoffEntry[]) => T,
): Promise<{ value: T; runoffs: RunoffEntry[] }> {
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const raw = await readRaw(path);
		const parsed = parseEntries(raw);
		const valid = parsed.flatMap((item) => ("entry" in item ? [item.entry] : []));
		const value = mutate(valid);
		const validQueue = [...valid];
		// Valid entries go back in their slots (in order), invalid ones stay; appended entries go at the end.
		const merged = parsed.map((item) => ("entry" in item ? validQueue.shift() : raw[item.index]));
		const next = [...merged.filter((entry) => entry !== undefined), ...validQueue];
		await lockedFileSystem.writeJsonFileAtomic(path, { runoffs: next }, { lock: null });
		return { value, runoffs: valid };
	});
}

/**
 * Handback (`kanban task handback`, P4-5): a runoff decided with no winner (every card escalated) reopens when one of
 * its cards comes back, keeping the old decision under `reopened[]`. Returns the reopened runoff's name, or null.
 * Ported from archive/devteam-kit:bin/kit@6da71597 (158817d; tier2-coupons 10/06: both cards escalated within 3 min,
 * one on a kit counting bug, one on a provider outage).
 */
export async function reopenRunoffWithoutWinner(path: string, taskId: string, at: string): Promise<string | null> {
	const reopens = (entry: RunoffEntry) =>
		entry.cards.includes(taskId) && Boolean(entry.decided) && !entry.winner && !entry.abandoned;
	// Read first: a workspace without runoffs (no runoffs.json) never gets the file.
	if (!(await readRunoffs(path)).runoffs.some(reopens)) {
		return null;
	}
	const { value } = await updateRunoffs(path, (runoffs) => {
		const runoff = runoffs.find(reopens);
		if (!runoff) {
			return null;
		}
		const previous = Array.isArray(runoff.reopened) ? runoff.reopened : [];
		runoff.reopened = [...previous, { at, by: taskId, decided: runoff.decided, results: runoff.results }];
		delete runoff.decided;
		delete runoff.winner;
		delete runoff.results;
		return runoff.name;
	});
	return value;
}
