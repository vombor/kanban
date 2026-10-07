// The hold (plan §4.0, `onPass`): after a QA PASS the kit may answer "hold" instead of "land" (only the team
// `runoffs` feature does, to compare several cards before one lands). A held card stays in Review with its PASS
// recorded in pipeline-state (`hold`), and the Done workflow refuses to finish it (the landing gate answers
// `held`) until `releaseHold()` lands or discards it. That is the only way out of a hold.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@83aa4d0 (runoffPass: a runoff card's PASS is
// held in Review; losers are tagged preserve/<id>-<model> and dropped, the winner goes back to the PASS path)
// and @2ffe609 (benchOnly: every PASS is preserved and nothing lands), as a mechanism with no runoff logic: the
// legacy kit deleted a loser because its Done always landed; here `discard` goes through the Done workflow
// without landing, with the work kept as the preserve tag.
import type { RuntimeTaskLandingChoice, RuntimeTaskTrashResponse } from "../core/api-contract";
import type { EffectiveCard, KitVerdict, OnPassAnswer, RoutingPolicy } from "../kits/policy";
import { tagPreservedWork } from "../workspace/land";
import type { PipelineCardState, PipelineStateStore } from "./pipeline-state";
import { findTaskWorktree } from "./rework-notes";
import { takeTaskSnapshot } from "./snapshots";

export interface PipelineHold {
	/** The runoff (or other) group the card is held for. */
	group: string;
	/** ISO time the PASS was held. */
	at: string;
	round: number;
}

export interface PipelineHoldRelease {
	at: string;
	group: string;
	decision: RuntimeTaskLandingChoice;
	tag: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The card's active hold from its pipeline-state entry, or null. */
export function readPipelineHold(entry: PipelineCardState | undefined): PipelineHold | null {
	const hold = entry?.hold;
	if (!isPlainObject(hold) || typeof hold.group !== "string" || typeof hold.at !== "string") {
		return null;
	}
	return { group: hold.group, at: hold.at, round: typeof hold.round === "number" ? hold.round : 0 };
}

/**
 * Asks the kit what to do with a PASS. `hold` is recorded at once, so the card can't be landed by a Done
 * meanwhile; `land` is returned for the caller to land through the Done workflow.
 */
export async function decideOnPass(input: {
	store: PipelineStateStore;
	policy: RoutingPolicy;
	dev: EffectiveCard;
	verdict: KitVerdict;
	now: number;
}): Promise<OnPassAnswer> {
	const answer = input.policy.onPass({ dev: input.dev, verdict: input.verdict });
	if (answer.action === "hold") {
		const hold: PipelineHold = {
			group: answer.group,
			at: new Date(input.now).toISOString(),
			round: input.verdict.round,
		};
		await input.store.update(input.dev.workspaceId, (state) => {
			const entry = state.cards[input.dev.card.id] ?? {};
			state.cards[input.dev.card.id] = { ...entry, hold };
			return state;
		});
	}
	return answer;
}

export interface ReleaseHoldInput {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	decision: RuntimeTaskLandingChoice;
	/** `preserve/<id>-<model>`: tags the card's work before it is finished (always kept on discard if given). */
	tag?: string | null;
}

export interface ReleaseHoldDependencies {
	store: PipelineStateStore;
	/** The Done workflow with `trigger: "hold_release"` and the decision as `landing`. */
	finishTask: (request: {
		workspaceId: string;
		workspacePath: string;
		taskId: string;
		landing: RuntimeTaskLandingChoice;
	}) => Promise<RuntimeTaskTrashResponse>;
	/** Tags the card's current work (src/workspace/land.ts tagPreservedWork on the worktree's commit). */
	preserveWork: (input: { workspacePath: string; taskId: string; tag: string }) => Promise<void>;
	now?: () => number;
}

export type ReleaseHoldResult =
	| { ok: true; result: RuntimeTaskTrashResponse; tag: string | null }
	| { ok: false; error: string; result?: RuntimeTaskTrashResponse };

/**
 * Lands or discards a held card. The tag (if any) is written first, so a discarded card's work survives even if
 * the Done workflow then fails; the hold is cleared only once the card really is Done. A land that conflicts
 * leaves the card held in Review.
 */
export async function releaseHold(deps: ReleaseHoldDependencies, input: ReleaseHoldInput): Promise<ReleaseHoldResult> {
	const now = deps.now ?? Date.now;
	const state = await deps.store.peek(input.workspaceId);
	const hold = readPipelineHold(state?.cards[input.taskId]);
	if (!hold) {
		return { ok: false, error: `task ${input.taskId} is not held` };
	}
	const tag = input.tag?.trim() || null;
	if (tag) {
		try {
			await deps.preserveWork({ workspacePath: input.workspacePath, taskId: input.taskId, tag });
		} catch (error) {
			return {
				ok: false,
				error: `could not tag ${tag}: ${error instanceof Error ? error.message : String(error)}; the card stays held`,
			};
		}
	}
	const result = await deps.finishTask({
		workspaceId: input.workspaceId,
		workspacePath: input.workspacePath,
		taskId: input.taskId,
		landing: input.decision,
	});
	if (!result.ok) {
		return { ok: false, error: result.error ?? `the Done workflow answered ${result.status}`, result };
	}
	const release: PipelineHoldRelease = {
		at: new Date(now()).toISOString(),
		group: hold.group,
		decision: input.decision,
		tag,
	};
	await deps.store.update(input.workspaceId, (current) => {
		const entry = { ...(current.cards[input.taskId] ?? {}) };
		delete entry.hold;
		const previous = Array.isArray(entry.holdReleases) ? entry.holdReleases : [];
		current.cards[input.taskId] = { ...entry, holdReleases: [...previous, release] };
		return current;
	});
	return { ok: true, result, tag };
}

/**
 * Tags a card's current work as `tag`: a dry-run `preserve` snapshot of its worktree (src/pipeline/snapshots.ts), so the
 * tag holds uncommitted work too. Throws when the card has no worktree.
 */
export async function preserveTaskWork(input: { workspacePath: string; taskId: string; tag: string }): Promise<string> {
	const worktreePath = await findTaskWorktree(input.workspacePath, input.taskId);
	if (!worktreePath) {
		throw new Error(`task ${input.taskId} has no worktree to preserve`);
	}
	const snapshot = await takeTaskSnapshot({
		worktreePath,
		taskId: input.taskId,
		baseRef: "HEAD",
		reason: "preserve",
		// The tag keeps the commit; the card's snapshot ref (what was checked and QA'd) stays as it is.
		dryRun: true,
	});
	await tagPreservedWork({ repoPath: input.workspacePath, tag: input.tag, commit: snapshot.commit });
	return snapshot.commit;
}
