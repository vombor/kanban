// The post-restart check: a Review dev card whose dead QA card the QA gate did not replace, and cards still held for
// a restart. Fixing a dead QA card is the gate's (qa-gate.ts: describeDeadQaCard, then it reads any verdict,
// supersedes the card and queues a new one for the same snapshot within its slots and PID pressure), so this only
// reports that the automatic fix didn't happen. It runs on every watchdog tick, so the first ticks after a Kanban
// start see it, not the generic "Review with no QA card" stall `stall.reviewMin` later (foo's 6f756 and 8d024 waited
// 11–14 min with a dead QA card after the 2026-10-07 23:02:56Z restart).
//
// For a dev card in Review, the newest QA card the gate made for it (`qaGate.reviewsTaskId`), > `restartGraceMin`:
//   dead (describeDeadQaCard) and still queued/running: not superseded since the start (or since the watchdog first
//     saw it gone, for one moved to Done or off the board)                                                   → item
//   superseded (not for a resent turn) with no newer QA card since `supersededAt`                             → item
//   superseded, or its replacement queued in Backlog, while PID pressure or the QA slots hold it              → note only
// Any non-QA card with a current orphan mark (`qaflow.orphan`, not isOrphanMarkStale) > grace + its place in the
//   resume queue (`resumeGapSec` per marked dev card), unless PID pressure holds the resumes                  → item
//
// Liveness is never re-derived here: describeDeadQaCard() and isOrphanMarkStale() decide on lostToRestart(), the
// restart rule the server's startup mark (interrupted) and restart recovery share.
import type { RuntimeBoardColumnId, RuntimeBoardData } from "../../core/api-contract";
import type { PipelineSessionView } from "../engine";
import type { PipelineCardState } from "../pipeline-state";
import { describeDeadQaCard, type QaGateEntry, readQaGateEntry, readQaVerdictRecords } from "../qa-gate";
import { isOrphanMarkStale, readRecoveryFlow } from "../recovery";
import { readEscalation, readStop, type StallItem, type WatchdogCardRole } from "./stalls";

const MIN = 60_000;

export interface RestartCheckSettings {
	/** `watchdog.stall.restartGraceMin`: how long the gate (or recovery) has for its automatic fix. */
	graceMin: number;
	/** `pipeline.recovery.resumeGapSec`: restart recovery resumes orphans one at a time, this far apart. */
	resumeGapSec: number;
}

export interface RestartCheckInput {
	board: RuntimeBoardData;
	sessions: ReadonlyMap<string, PipelineSessionView>;
	roles: ReadonlyMap<string, WatchdogCardRole>;
	pipelineCards: Readonly<Record<string, PipelineCardState>>;
	/** When this Kanban server started (the snapshot's `serverStartedAt`). */
	serverStartedAt: number | undefined;
	userItemIds: ReadonlySet<string>;
	/** PID pressure: the gate creates and starts no QA card and recovery resumes nothing until it clears. */
	pidPressure: boolean;
	/**
	 * The caller's memory of when a QA card was first seen gone (in Done or off the board: nothing records when it went),
	 * by `<devTaskId>:<qaTaskId>`. Updated here; keys no longer gone are dropped.
	 */
	firstSeenGone: Map<string, number>;
	settings: RestartCheckSettings;
	now: number;
}

/** A card the gate is replacing within its limits: logged, never an item. */
export interface RestartCheckNote {
	taskId: string;
	note: string;
}

export interface RestartCheckResult {
	items: StallItem[];
	notes: RestartCheckNote[];
}

function iso(at: number): string {
	return new Date(at).toISOString();
}

const NOT_REPLACED = "the automatic QA replacement didn't happen";

function describeEntry(qaTaskId: string, entry: QaGateEntry): string {
	return `QA card ${qaTaskId} (round ${entry.round}, snapshot ${entry.snapshot.slice(0, 8)})`;
}

export function detectRestartQaGaps(input: RestartCheckInput): RestartCheckResult {
	const { now, serverStartedAt } = input;
	const graceMs = input.settings.graceMin * MIN;
	const items: StallItem[] = [];
	const notes: RestartCheckNote[] = [];
	const cards = input.board.columns.flatMap((column) => column.cards.map((card) => ({ column: column.id, card })));
	const columnOf = new Map<string, RuntimeBoardColumnId>(cards.map(({ column, card }) => [card.id, column]));

	// Orphan marks: dev cards are recovery's to resume; a QA card's mark hands it to the gate (the QA rules below).
	const orphanMarked = new Set<string>();
	let markedDevCount = 0;
	for (const { column, card } of cards) {
		if (column !== "in_progress" && column !== "review") {
			continue;
		}
		const role = input.roles.get(card.id)?.role ?? "dev";
		if (role === "calibration" || role === "plan" || role === "qa") {
			continue;
		}
		const flow = readRecoveryFlow(input.pipelineCards[card.id]);
		if (!flow.orphan || isOrphanMarkStale(flow, input.sessions.get(card.id) ?? null, serverStartedAt)) {
			continue;
		}
		orphanMarked.add(card.id);
		if (role === "dev") {
			markedDevCount += 1;
		}
	}
	const queueMs = markedDevCount * input.settings.resumeGapSec * 1000;
	for (const taskId of orphanMarked) {
		const orphan = readRecoveryFlow(input.pipelineCards[taskId]).orphan;
		const markedAt = Date.parse(orphan?.at ?? "");
		if (input.pidPressure || input.userItemIds.has(taskId) || !Number.isFinite(markedAt)) {
			continue;
		}
		if (now - markedAt < graceMs + queueMs) {
			continue;
		}
		items.push({
			key: `${taskId}:restart-held:${orphan?.kanbanStart ?? "?"}`,
			taskId,
			issue: `card is still held for the Kanban restart of ${orphan?.kanbanStart ?? "?"} (orphaned ${orphan?.at}, ${Math.round((now - markedAt) / MIN)} min ago; ${columnOf.get(taskId)}, session ${input.sessions.get(taskId)?.state ?? "missing"}): restart recovery has not resumed it, and nothing QAs, nudges or escalates it while it is marked; by hand: kanban task resume ${taskId}`,
		});
	}

	// The gate's QA cards by the dev card they review, newest first.
	const qaByDev = new Map<string, Array<{ qaTaskId: string; entry: QaGateEntry }>>();
	for (const [qaTaskId, raw] of Object.entries(input.pipelineCards)) {
		const entry = readQaGateEntry(raw);
		if (entry) {
			qaByDev.set(entry.reviewsTaskId, [...(qaByDev.get(entry.reviewsTaskId) ?? []), { qaTaskId, entry }]);
		}
	}
	const seenGone = new Set<string>();
	for (const { column, card } of cards) {
		if (column !== "review" || (input.roles.get(card.id)?.role ?? "dev") !== "dev" || orphanMarked.has(card.id)) {
			continue;
		}
		const devEntry = input.pipelineCards[card.id];
		if (readEscalation(devEntry) || readStop(devEntry) || input.userItemIds.has(card.id)) {
			continue;
		}
		const newest = (qaByDev.get(card.id) ?? []).sort((a, b) => b.entry.createdAt - a.entry.createdAt)[0];
		if (!newest) {
			continue;
		}
		const { qaTaskId, entry } = newest;
		const about = describeEntry(qaTaskId, entry);
		if (
			entry.status === "ingested" ||
			readQaVerdictRecords(devEntry).some((record) => record.qaTaskId === qaTaskId)
		) {
			continue;
		}
		if (entry.status === "superseded") {
			// Superseded for a turn recovery resent: the redone turn's own Review gets the next QA card.
			const sentAt = Date.parse(readRecoveryFlow(devEntry).recoverySentAt ?? "");
			if (Number.isFinite(sentAt) && sentAt > entry.createdAt) {
				continue;
			}
			const supersededAt = entry.supersededAt ?? entry.createdAt;
			if (input.pidPressure) {
				notes.push({
					taskId: card.id,
					note: `${about} was superseded at ${iso(supersededAt)}; its replacement is waiting for PID pressure to clear`,
				});
				continue;
			}
			if (now - supersededAt < graceMs) {
				continue;
			}
			items.push({
				key: `${card.id}:qa-not-replaced:${qaTaskId}`,
				taskId: card.id,
				issue: `dev card is in Review and ${NOT_REPLACED}: the QA gate superseded its dead ${about} at ${iso(supersededAt)}, ${Math.round((now - supersededAt) / MIN)} min ago, and made no new QA card since`,
			});
			continue;
		}
		const qaColumn = columnOf.get(qaTaskId) ?? null;
		const dead = describeDeadQaCard({
			column: qaColumn,
			session: input.sessions.get(qaTaskId) ?? null,
			entry,
			flow: readRecoveryFlow(input.pipelineCards[qaTaskId]),
			serverStartedAt,
			now,
		});
		if (!dead) {
			// A replacement (an older QA card of the gate's was superseded) queued in Backlog waits within the limits.
			const isReplacement = (qaByDev.get(card.id) ?? []).some((other) => other.entry.status === "superseded");
			if (isReplacement && entry.status === "queued" && qaColumn === "backlog") {
				notes.push({
					taskId: card.id,
					note: `${about} replaces a dead QA card and is queued: waiting for ${input.pidPressure ? "PID pressure to clear" : "a QA slot or provider capacity"}`,
				});
			}
			continue;
		}
		const gone = qaColumn === null || qaColumn === "trash";
		const goneKey = `${card.id}:${qaTaskId}`;
		if (gone) {
			seenGone.add(goneKey);
			if (!input.firstSeenGone.has(goneKey)) {
				input.firstSeenGone.set(goneKey, now);
			}
		}
		const since = gone ? (input.firstSeenGone.get(goneKey) ?? now) : (serverStartedAt ?? now);
		if (now - since < graceMs) {
			continue;
		}
		items.push({
			key: `${card.id}:qa-not-replaced:${qaTaskId}`,
			taskId: card.id,
			issue: `dev card is in Review and ${NOT_REPLACED}: its ${about} ${dead}, has no verdict, and the QA gate has not superseded it ${Math.round((now - since) / MIN)} min on`,
		});
	}
	for (const key of [...input.firstSeenGone.keys()]) {
		if (!seenGone.has(key)) {
			input.firstSeenGone.delete(key);
		}
	}
	return { items, notes };
}
