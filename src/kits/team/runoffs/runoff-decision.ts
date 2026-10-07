// Deciding a runoff (pure): several dev cards race on the same task on different models, and each one's QA PASS is
// held (the core hold, src/pipeline/hold.ts). Once every card has a held PASS for its current snapshot or is
// escalated, the highest mean QA score wins; ties go to fewer FAIL rounds, then to lower cost. The winner lands
// (unless the runoff is `benchOnly`); every losing PASS (every PASS for `benchOnly`) is tagged
// `preserve/<id>-<model>` and discarded through the Done workflow. Escalated cards are left to the human.
//
// A card trashed or deleted by hand closes the runoff without touching the others: it only has a winner if exactly
// one of those cards held a runoff PASS.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (decideRunoffs): 83aa4d0
// (runoffs, tier-3 runoff luna vs gpt-6.1-sol 10/06), 2ffe609 (benchOnly), 4007b3b (closed by hand: tier2-coupons
// 10/06 08:51Z, both cards trashed with no PASS and 096bd was recorded as the winner).
import type { RuntimeBoardColumnId } from "../../../core/api-contract";
import { buildPreserveTag } from "../../../pipeline/rework-text";
import type { RunoffEntry, RunoffResult } from "./runoffs-store";

/** What the feature knows about one runoff card when it decides. */
export interface RunoffCardFacts {
	id: string;
	/** null = not on the board any more (deleted). */
	column: RuntimeBoardColumnId | null;
	/** The pipeline escalated it (BLOCKED, waiting for the orchestrator or the user). */
	escalated: boolean;
	/** Its PASS is held for this runoff: the round and the snapshot QA passed. */
	held: { round: number; snapshot: string | null; at: string } | null;
	/** Its current snapshot (`refs/kanban/snapshots/<id>`). */
	currentSnapshot: string | null;
	/** The model it was built on. */
	model: string | null;
	/** The numeric QA scores of the held PASS round. */
	scores: number[];
	/** FAIL rounds before the PASS. */
	fails: number;
	/** USD the card cost, null when unknown. */
	cost: number | null;
}

export type RunoffDecision =
	/** Some card is still working (or was QA'd on an older snapshot): wait. */
	| { kind: "open"; waitingFor: string[] }
	| { kind: "closed_by_hand"; winner: string | null; results: RunoffResult[]; note: string }
	| {
			kind: "decided";
			/** The best PASS, or null when no card passed. */
			winner: RunoffResult | null;
			results: RunoffResult[];
			/** Land this one (null for `benchOnly` or no PASS). */
			land: RunoffResult | null;
			/** Tag `preserve/<id>-<model>` and discard these. */
			discard: RunoffResult[];
	  };

/** `preserve/<id>-<model>`, the same tag the rework stage gives an escalated card's work (rework-text.ts). */
export function getRunoffPreserveTag(result: Pick<RunoffResult, "id" | "model">): string {
	return buildPreserveTag(result.id, result.model);
}

function meanScore(scores: readonly number[]): number {
	if (scores.length === 0) {
		return 0;
	}
	return Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2));
}

/** Higher score first, then fewer FAIL rounds, then lower cost (unknown cost last). */
export function compareRunoffPasses(left: RunoffResult, right: RunoffResult): number {
	return (
		(right.score ?? 0) - (left.score ?? 0) ||
		(left.fails ?? 0) - (right.fails ?? 0) ||
		(left.cost ?? Number.POSITIVE_INFINITY) - (right.cost ?? Number.POSITIVE_INFINITY)
	);
}

/**
 * How long a runoff card that is not on the board yet counts as being created rather than deleted: the rework stage
 * records a group before it creates the sibling cards, and the board snapshot of that tick predates them.
 */
export const RUNOFF_NEW_CARD_GRACE_MS = 10 * 60_000;

export function decideRunoff(
	runoff: RunoffEntry,
	cards: readonly RunoffCardFacts[],
	options: { now: number },
): RunoffDecision {
	const createdAt = runoff.createdAt ? Date.parse(runoff.createdAt) : Number.NaN;
	const isNew = Number.isFinite(createdAt) && options.now - createdAt < RUNOFF_NEW_CARD_GRACE_MS;
	const byId = new Map(cards.map((card) => [card.id, card]));
	const results: RunoffResult[] = [];
	const waitingFor: string[] = [];
	for (const id of runoff.cards) {
		const card = byId.get(id);
		if (!card || card.column === null) {
			if (isNew) {
				waitingFor.push(id);
			} else {
				results.push({ id, out: "gone" });
			}
			continue;
		}
		if (card.column === "trash") {
			results.push({ id, out: "done", ...(card.held ? { passed: true } : {}) });
			continue;
		}
		if (card.escalated) {
			results.push({ id, out: "escalated" });
			continue;
		}
		const held = card.held;
		if (card.column !== "review" || !held || !held.snapshot || held.snapshot !== card.currentSnapshot) {
			waitingFor.push(id);
			continue;
		}
		results.push({
			id,
			out: "pass",
			snapshot: held.snapshot,
			round: held.round,
			ts: held.at,
			model: card.model,
			score: meanScore(card.scores),
			fails: card.fails,
			cost: card.cost,
		});
	}
	if (waitingFor.length > 0) {
		return { kind: "open", waitingFor };
	}
	if (results.some((result) => result.out === "done" || result.out === "gone")) {
		// Kanban's Done column is "trash": a trashed card may have been finished by hand; a deleted one never wins.
		const passedByHand = results.filter((result) => result.out === "done" && result.passed);
		const winner = passedByHand.length === 1 ? (passedByHand[0]?.id ?? null) : null;
		return {
			kind: "closed_by_hand",
			winner,
			results,
			note: `card(s) moved to Done or deleted outside the pipeline; ${winner ? `${winner} held the only runoff PASS` : "no winner (no single card with a runoff PASS)"}`,
		};
	}
	// `fails` counts every FAIL round of a card, so the round whose FAIL started a runoff (onFail.runoff) counts against
	// the card that failed it: a tie on score goes to a sibling.
	const passes = results.filter((result) => result.out === "pass").sort(compareRunoffPasses);
	const winner = passes[0] ?? null;
	const benchOnly = runoff.benchOnly === true;
	return {
		kind: "decided",
		winner,
		results,
		land: benchOnly ? null : winner,
		discard: benchOnly ? passes : passes.slice(1),
	};
}
