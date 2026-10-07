// The plan card's prompt: a core template wrapped around the user's requirement, with the kit's `plan.rules` added.
// The planner is the architect, not the scrum master (user 2026-10-07): it reads the codebase, writes a reviewed spec
// and a card breakdown, and stops. It never creates, starts or links cards: the user approves the breakdown and the
// orchestrator runs `kanban plan expand`, which turns it into Backlog dev cards (src/plans/plan-expand.ts).
//
// The breakdown's shape is planBreakdownSchema (src/plans/plan-breakdown.ts); the example below must stay valid
// against it (test/runtime/plans/plan-prompt.test.ts parses it).
import { getPlanSpecPaths, PLAN_BREAKDOWN_VERSION, PLAN_MAX_CARDS } from "../plans/plan-breakdown";

export interface PlanPromptInput {
	/** The user's business requirement, verbatim. */
	requirement: string;
	slug: string;
	/** The kit's `plan.rules` texts. */
	rules: readonly string[];
	/** The card starts in the agent's plan mode (read-only until the user accepts the plan). */
	startInPlanMode: boolean;
}

/** The breakdown example the prompt shows; valid against planBreakdownSchema. */
export function buildPlanBreakdownExample(slug: string): string {
	return JSON.stringify(
		{
			version: PLAN_BREAKDOWN_VERSION,
			slug,
			summary: "One paragraph: what the cards deliver together.",
			cards: [
				{
					id: "schema",
					title: "Add the coupons table and its migration",
					prompt:
						"The whole task for one agent session: what to change, in which files and modules, and how to check it.",
					role: "dev",
					dependsOn: [],
					parallelGroup: "wave-1",
					acceptanceCriteria: ["npm test passes with a new migration test", "the coupons table has a unique code"],
				},
				{
					id: "api",
					title: "Coupon redemption endpoint",
					prompt: "The whole task for one agent session, self-contained (the dev agent sees only this prompt).",
					role: "dev",
					dependsOn: ["schema"],
					parallelGroup: "wave-2",
					acceptanceCriteria: ["POST /api/coupons/redeem returns 409 for a used code"],
				},
			],
		},
		null,
		2,
	);
}

export function buildPlanPrompt(input: PlanPromptInput): string {
	const { specPath, breakdownPath } = getPlanSpecPaths(input.slug);
	const rules = input.rules.map((rule) => rule.trim()).filter(Boolean);
	const planMode = input.startInPlanMode
		? `
You start in plan mode (read-only). Do steps 1 and 2 there, then present a short outline of the spec and the cards as your plan. Once the user accepts it, you leave plan mode: write the two files (steps 3-5).
`
		: "";
	return `You are the planning agent (the architect) for this project. Turn the business requirement below into a reviewed spec and a breakdown into dev cards. You do NOT implement it, and you do NOT create, start, link or move any card (no kanban task commands): the user reviews your plan, and the orchestrator turns the approved breakdown into cards.
${planMode}
1. READ THE CODEBASE you plan against before you design anything: the README, AGENTS.md/CLAUDE.md, the modules and files the requirement touches, their tests, and how similar features were built. A design that cites no real file is not a design. Note every file and module you read for the spec.
2. If the requirement is unclear or contradicts the code, list your questions under "Open questions" and say so in the STATUS line; do not guess silently. If it is really one small, non-cross-cutting change (one card, one module), say so: it doesn't need a plan.
3. THE SPEC: write ${specPath} with these sections, in this order:
   - Problem
   - Goals
   - Non-goals
   - User-visible behaviour (what a user sees and does, step by step)
   - Design (cite the real files and modules: what changes in each, new modules, data shapes, interfaces)
   - Risks
   - Test plan (unit, integration, end-to-end; which existing tests change)
   - Rollout / flags (migration, feature flag, config, backwards compatibility)
   - Open questions
4. THE CARDS: write ${breakdownPath} (valid JSON, double quotes), shaped like this example:
${buildPlanBreakdownExample(input.slug)}
   Rules for the cards:
   a. Each card is sized for ONE agent session: one coherent change a junior agent can finish, test and hand back in a single run. Split anything bigger.
   b. Each prompt is self-contained: the dev agent sees only its own card prompt (plus the spec in the repo once the plan lands), so name the files, the behaviour and the checks. "role" is always "dev".
   c. "dependsOn" lists the local ids of cards that must be done first; cards without dependencies between them can run in parallel, and "parallelGroup" names a set of cards that can run at the same time (no card may depend on a card of its own group). No cycles.
   d. Every card has concrete, checkable "acceptanceCriteria"; QA judges the card against them.
   e. At most ${PLAN_MAX_CARDS} cards; a bigger requirement is several plans.
   f. "slug" is "${input.slug}". Check the file with: kanban plan check --file ${breakdownPath} (the one kanban command you may run).
5. Leave both files uncommitted in your worktree; change nothing else.${rules.length > 0 ? `\n\nProject rules for plans:\n${rules.map((rule) => `- ${rule}`).join("\n")}` : ""}

Finish with one line: "STATUS: PLAN READY ${specPath}, <n> cards", "STATUS: NEEDS INPUT <your questions>", "STATUS: TOO SMALL <why one card is enough>" or "STATUS: BLOCKED <why>".

Business requirement:
"""
${input.requirement.trim()}
"""`;
}

// The marker `kanban plan show|expand` read a plan card's slug from when the plan index has no entry for it.
const PLAN_PROMPT_BREAKDOWN_PATH = /docs\/specs\/([a-z0-9][a-z0-9-]{0,63})\.cards\.json/u;

/** The slug a plan prompt names, or null. */
export function readPlanSlugFromPrompt(prompt: string): string | null {
	return PLAN_PROMPT_BREAKDOWN_PATH.exec(prompt)?.[1] ?? null;
}
