// What `kanban plan expand` does with an approved breakdown, as pure decisions: whether the plan card may be
// expanded now, which cards it becomes (task ids chosen up front, reused when an earlier expand stopped half way),
// their prompts (the breakdown prompt plus its acceptance criteria) and the board links between them.
//
// Expansion never starts a card and never links a card to the plan card itself: a link to the plan card would start
// the first wave the moment the plan card goes Done, and starting cards is the orchestrator's call.
import { createHash } from "node:crypto";

import type { RuntimeBoardColumnId } from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { insertBeforeFinalStep } from "../pipeline/rework-text";
import type { PlanBreakdown, PlanBreakdownCard } from "./plan-breakdown";
import type { PlanApproval, PlanExpansion, PlanRecord } from "./plan-index";

export function hashPlanBreakdown(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The heading QA requirements and the dev agent read the criteria under (buildQaRequirements keeps it). */
export const PLAN_ACCEPTANCE_CRITERIA_HEADING = "Acceptance criteria";

/**
 * The card prompt: the breakdown prompt with its acceptance criteria appended (before a FINAL STEP section, which
 * the QA requirements cut off), so QA judges the card against them.
 */
export function buildPlannedCardPrompt(
	card: Pick<PlanBreakdownCard, "prompt" | "acceptanceCriteria">,
	context: { planTaskId: string; specPath: string },
): string {
	const section = [
		`${PLAN_ACCEPTANCE_CRITERIA_HEADING} (from plan card ${context.planTaskId}; spec ${context.specPath}, in the repo once the plan card has landed):`,
		...card.acceptanceCriteria.map((criterion) => `- ${criterion}`),
	].join("\n");
	return insertBeforeFinalStep(card.prompt.trim(), section);
}

export interface PlannedCard {
	localId: string;
	taskId: string;
	title: string;
	prompt: string;
	/** Already on the board (an earlier expand created it). */
	exists: boolean;
}

export interface PlannedLink {
	waiting: string;
	prerequisite: string;
}

export interface PlannedExpansion {
	cards: PlannedCard[];
	/** By local id, in breakdown order. */
	links: PlannedLink[];
	/** Local id → task id. */
	taskIds: Record<string, string>;
}

export function planExpansion(input: {
	breakdown: PlanBreakdown;
	planTaskId: string;
	specPath: string;
	/** Every task id on the board. */
	boardTaskIds: ReadonlySet<string>;
	/** The ids an earlier, unfinished expand chose. */
	previous: PlanExpansion | null;
	randomUuid: () => string;
}): PlannedExpansion {
	const taken = new Set(input.boardTaskIds);
	const taskIds: Record<string, string> = {};
	const cards = input.breakdown.cards.map((card): PlannedCard => {
		const previousId = input.previous?.cards[card.id];
		const taskId = previousId ?? createUniqueTaskId(taken, input.randomUuid);
		taken.add(taskId);
		taskIds[card.id] = taskId;
		return {
			localId: card.id,
			taskId,
			title: card.title,
			prompt: buildPlannedCardPrompt(card, { planTaskId: input.planTaskId, specPath: input.specPath }),
			exists: previousId !== undefined && input.boardTaskIds.has(previousId),
		};
	});
	const links = input.breakdown.cards.flatMap((card) =>
		card.dependsOn.map((prerequisite) => ({ waiting: card.id, prerequisite })),
	);
	return { cards, links, taskIds };
}

export type PlanExpandCheck =
	| { ok: true; approval: PlanApproval | null; needsApproval: boolean }
	| { ok: false; error: string };

/**
 * May the plan card be expanded now? It must be a plan card in Review, not expanded yet, and approved by the user for
 * exactly this breakdown: a recorded approval (`kanban plan approve`) whose hash matches, or `--approved-by-user`
 * (`needsApproval`: the caller confirms with the user, then records it).
 */
export function checkPlanExpandable(input: {
	taskId: string;
	role: string;
	column: RuntimeBoardColumnId | null;
	record: PlanRecord | null;
	breakdownSha256: string;
	approvedByUser: boolean;
	dryRun: boolean;
}): PlanExpandCheck {
	if (input.column === null) {
		return { ok: false, error: `Task ${input.taskId} is not on the board.` };
	}
	if (input.role !== "plan") {
		return { ok: false, error: `Task ${input.taskId} is a ${input.role} card, not a plan card.` };
	}
	if (input.record?.expansion?.status === "done") {
		return {
			ok: false,
			error: `Plan ${input.taskId} was already expanded at ${input.record.expansion.finishedAt ?? input.record.expansion.startedAt}.`,
		};
	}
	if (input.column !== "review") {
		return {
			ok: false,
			error: `Plan ${input.taskId} is in ${input.column}; it is expanded only from Review, once its planner has finished.`,
		};
	}
	const approval = input.record?.approval ?? null;
	if (approval && approval.breakdownSha256 !== input.breakdownSha256) {
		if (input.approvedByUser) {
			return { ok: true, approval: null, needsApproval: true };
		}
		return {
			ok: false,
			error: `The breakdown of plan ${input.taskId} changed after the user approved it at ${approval.at}; it needs a new approval (kanban plan approve ${input.taskId}).`,
		};
	}
	if (approval) {
		return { ok: true, approval, needsApproval: false };
	}
	if (input.approvedByUser) {
		return { ok: true, approval: null, needsApproval: true };
	}
	if (input.dryRun) {
		return { ok: true, approval: null, needsApproval: false };
	}
	return {
		ok: false,
		error: `Plan ${input.taskId} is not approved. The user approves it with kanban plan approve ${input.taskId} (or kanban plan expand ${input.taskId} --approved-by-user, which asks to confirm).`,
	};
}
