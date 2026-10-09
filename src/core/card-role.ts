// A card's role for the pipeline: its `role` field, else (only for a card with no role) what the legacy kit made it.
//
// New QA, TRIAGE and calibration cards carry `role` (the pipeline and the creators set it), and nothing decides on
// titles or prompts for them. Cards the legacy kit created before cutover have no `role`, and the board still holds
// them (QA cards in progress, spare QA cards in Backlog, calibration runs, TRIAGE cards). Read as `dev`, the pipeline
// would ask the kit to QA a QA card. So a role-less card gets one of the legacy kit's own creation markers checked:
// the exact title and prompt shapes its scripts wrote, never a loose "starts with QA" (a dev card titled "QA gate: …"
// stays a dev card). This bridge goes when the legacy cards are gone (P5-4).
import type { RuntimeBoardCard, RuntimeLandingMode, RuntimeTaskRole } from "./api-contract";

/** A board card, or a card-shaped record from the legacy kit (whose title may be missing). */
export interface CardRoleInput {
	role?: RuntimeTaskRole;
	title?: string;
	prompt: string;
}
export type CardRoleSource = "card" | "legacy" | "default";

// Ported from archive/devteam-kit:lib/calibration.cjs@9828540 (CAL_TITLE, CAL_PROMPT: qa/calibrate.mjs's cards).
const LEGACY_CALIBRATION_TITLE = /^QA-CAL\b/u;
const LEGACY_CALIBRATION_PROMPT = /^You are the QA reviewer \(calibration\b/u;
// Ported from archive/devteam-kit:qa/qa-card.cjs@9828540 (QA_TITLE "QA<n> <devId>:", QA_PROMPT_DEV) and
// services/kanban-autoland.mjs@9828540 (NOT_FLOW_TITLE also skips "BENCH QA …"). Its loose "judge" title rule is
// not ported: judge cards were hand-made by the orchestrator, and a dev card may well be titled "Judge …".
const LEGACY_QA_TITLE = /^(?:BENCH )?QA\d* [0-9a-f]{5}:/u;
const LEGACY_QA_PROMPT = /^You are the QA reviewer\b[^\n]*?\bfor Kanban dev card \w+/u;
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@9828540 and services/review-watch.mjs@9828540
// (both create "TRIAGE <devId>: <issue>" cards whose prompt starts with the triage-agent intro).
const LEGACY_TRIAGE_TITLE = /^TRIAGE [0-9a-f]{5}:/u;
const LEGACY_TRIAGE_PROMPT = /^You are the Kanban orchestrator's triage agent\b/u;

/** The role a role-less card had under the legacy kit, or null when it carries none of its markers. */
export function inferLegacyCardRole(card: Omit<CardRoleInput, "role">): RuntimeTaskRole | null {
	const title = card.title?.trim() ?? "";
	const prompt = card.prompt.trimStart();
	if (LEGACY_CALIBRATION_TITLE.test(title) || LEGACY_CALIBRATION_PROMPT.test(prompt)) {
		return "calibration";
	}
	if (LEGACY_QA_TITLE.test(title) || LEGACY_QA_PROMPT.test(prompt)) {
		return "qa";
	}
	if (LEGACY_TRIAGE_TITLE.test(title) || LEGACY_TRIAGE_PROMPT.test(prompt)) {
		return "triage";
	}
	return null;
}

export function resolveCardRoleWithSource(card: CardRoleInput): { role: RuntimeTaskRole; source: CardRoleSource } {
	if (card.role) {
		return { role: card.role, source: "card" };
	}
	const legacy = inferLegacyCardRole(card);
	return legacy ? { role: legacy, source: "legacy" } : { role: "dev", source: "default" };
}

/** `card.role`, else the legacy kit's markers, else `dev`. */
export function resolveCardRole(card: CardRoleInput): RuntimeTaskRole {
	return resolveCardRoleWithSource(card).role;
}

// A plan card's spec files are docs that belong in the repo next to the code, so on a landing-mode-`qa` workspace
// they land the way the project's dev work lands: a human's Approve & land, or Done with "land". Only the trigger
// differs: the pipeline never QAs a plan card, so nothing lands one on a PASS.
const KANBAN_LANDED_ROLES: ReadonlySet<RuntimeTaskRole> = new Set(["dev", "plan"]);

/** A dev or plan card: its worktree holds the project's work (code, a spec), so no Done may drop it unasked. */
export function isProjectWorkCard(card: CardRoleInput): boolean {
	return KANBAN_LANDED_ROLES.has(resolveCardRole(card));
}

/**
 * Whether Kanban itself lands this card (the `qa` landing step, src/server/task-landing-gate.ts): a dev or plan card
 * on a landing-mode-`qa` workspace that the auto-review reconciler doesn't own (auto-review on with `commit`/`pr`).
 * Its Commit / Open PR buttons become Approve & land, and its Done asks "land or discard?".
 */
export function isKanbanLandedCard(
	card: CardRoleInput & Pick<RuntimeBoardCard, "autoReviewEnabled" | "autoReviewMode">,
	landingMode: RuntimeLandingMode | null | undefined,
): boolean {
	return (
		landingMode === "qa" &&
		isProjectWorkCard(card) &&
		!(card.autoReviewEnabled === true && card.autoReviewMode !== "qa")
	);
}

// Ported from archive/devteam-kit:services/kanban-autoland.mjs@9828540 (queueQa: the prompt names the dev card
// reliably; old QA titles can carry a previous dev id, QA 08be2 → c1e30 on 10/05).
const LEGACY_QA_PROMPT_DEV = /^You are the QA reviewer\b[^\n]*?\bfor Kanban dev card (\w+)/u;
const LEGACY_QA_TITLE_DEV = /^(?:BENCH )?QA\d* ([0-9a-f]{5}):/u;

/** The dev card a QA card reviews: `reviewsTaskId`, else (a legacy QA card) the id its prompt names, else its title's. */
export function resolveReviewedTaskId(card: CardRoleInput & { reviewsTaskId?: string }): string | null {
	if (card.reviewsTaskId) {
		return card.reviewsTaskId;
	}
	if (resolveCardRole(card) !== "qa") {
		return null;
	}
	return (
		LEGACY_QA_PROMPT_DEV.exec(card.prompt.trimStart())?.[1] ??
		LEGACY_QA_TITLE_DEV.exec(card.title?.trim() ?? "")?.[1] ??
		null
	);
}
