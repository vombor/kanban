// The QA prompt (plan §2.4): a core skeleton (the snapshot, the scratch copy, the outbox, the verdict contract,
// the round) with the kit's prompt parts filled in (route rules, project blurb, notes, the servers script). The kit
// never writes the prompt itself; it only answers `qaPolicy` with `promptParts`.
//
// Ported from archive/devteam-kit:qa/qa-card.cjs@6da71597 (buildPrompt, requirementsOf, PROMPT_RULES: QA process
// v4). The text is kept word for word so foo's QA prompt from the `team` kit equals the legacy kit's
// (`team-qa-prompt.test.ts`, P4-T1), and so is each rule behind it:
// - QA isolation (4d41fe5): QA only reviews and writes OUT/verdict.json; it runs no kanban command and never
//   touches the dev worktree, the project or the Kanban home. The pipeline ingests the verdict.
// - Three-dot diff against the base (359a871): commits that landed on the base after the card started are not
//   reverts (bfb20's false FAIL).
// - Seeded DB in the scratch copy and scripted journeys (5a6c1ba); browser tooling run from the project with
//   --target <scratch>, never preview/preview:stop (66797d9: preview:stop stopped the user's shared preview).
// - Blocking issues need quoted evidence and one rerun (6db784f: a false blocker in calibration v5).
// - Route rules (ef523b2, the `drive` rule for Haiku) are extra step-3 items lettered from h.
import type { QaPromptParts } from "../kits/policy";

/** Where a rule text names the QA card's outbox. */
export const QA_RULE_OUTBOX_PLACEHOLDER = "{outbox}";

export interface QaPromptInput {
	devTaskId: string;
	round: number;
	/** The dev card's title (its first line goes into the intro). */
	devTitle: string;
	/** From buildQaRequirements(). */
	requirements: string;
	/** The project's main checkout (`git -C` target for the snapshot and the base). */
	repoPath: string;
	/** The ref that holds the submitted work, e.g. `refs/kanban/snapshots/<id>`. */
	snapshotRef: string;
	baseRef: string;
	/** The scratch copy QA tests in (`<pipeline.qa.scratchRoot>/<devTaskId>`). */
	scratchDir: string;
	/** The QA card's outbox (`<pipeline.qa.outboxRoot>/<qaTaskId>`). */
	outboxDir: string;
	/** Earlier rounds' QA-log sections (qa-log.ts), quoted from round 2 on. */
	previousRounds: string;
	parts: QaPromptParts;
	/** The Kanban home as the agent should read it (getKanbanHomeDisplayPath()); QA must not touch it. */
	kanbanHome: string;
	/** Replaces the default intro sentence (calibration runs, P4-T4). */
	intro?: string;
}

/** The first line of a card title, as the QA intro and the QA card title quote it. */
export function getQaShortTitle(title: string): string {
	return title.replace(/\n.*/su, "").slice(0, 50);
}

/**
 * The dev requirements QA judges against: the dev prompt without its FINAL STEP (QA must not run it), with the
 * kit's project blurb first when the prompt has no "Project:" context of its own.
 */
export function buildQaRequirements(devPrompt: string, blurb: string): string {
	const requirements = devPrompt.replace(/\n+FINAL STEP[\s\S]*$/u, "").trim();
	return blurb && !/\bProject:/u.test(requirements) ? `${blurb}\n\n${requirements}` : requirements;
}

function buildRuleItems(rules: readonly string[], outboxDir: string): string {
	// h., i., …: steps a.–g. of step 3 are the skeleton's.
	return rules
		.map(
			(rule, index) =>
				`\n   ${String.fromCharCode(104 + index)}. ${rule.split(QA_RULE_OUTBOX_PLACEHOLDER).join(outboxDir)}`,
		)
		.join("");
}

function buildFallbackNote(input: QaPromptInput): string {
	const { screenshotFallback } = input.parts.notes;
	const script = input.parts.serversScript;
	const notes = [screenshotFallback.trim()];
	if (script) {
		notes.push(
			`Fallback when the project tooling fails: start the scratch copy's servers with ${script} (read it first for its arguments), then shoot them with kanban qa shot --base <url> --out ${input.outboxDir} --scratch ${input.scratchDir} --routes <route,...> (the one kanban command you may run).`,
		);
	}
	const text = notes.filter(Boolean).join(" ");
	return text ? ` ${text}` : "";
}

export function buildQaPrompt(input: QaPromptInput): string {
	const OUT = input.outboxDir;
	const S = input.scratchDir;
	const SNAP = input.snapshotRef;
	const BASE = input.baseRef;
	const P = input.repoPath;
	const { dbSetup, knownBaseIssues } = input.parts.notes;
	const prev = input.round > 1 ? input.previousRounds : "";
	const extra = buildRuleItems(input.parts.rules, OUT);
	const intro =
		input.intro ??
		`You are the QA reviewer (round ${input.round}) for Kanban dev card ${input.devTaskId} ("${getQaShortTitle(input.devTitle)}")`;
	return `${intro}, built by a junior agent. You ONLY review and report. Do NOT edit files in the dev worktree, in ${P}, or anywhere under ${input.kanbanHome}; do NOT run any kanban command (no task start/done/update/create, on any card) and do NOT run scripts from ${input.kanbanHome}: the orchestrator handles all of that from your report. Keep tool output small (redirect to files, then tail/grep).
Your outbox for this round: OUT=${OUT}. Run mkdir -p ${OUT} first; everything you produce goes there.
${
	prev
		? `
Earlier QA rounds for this card (check whether each blocking issue is now fixed):
"""
${prev}
"""
`
		: ""
}
1. THE WORK: it is snapshotted at ${SNAP} in ${P} (git rev-parse -q --verify ${SNAP} must succeed; if it doesn't, write the STALLED verdict in step 6 and stop). Review the diff against the point where the card branched (three dots, so commits that landed on ${BASE} after the card started do not look like the card reverting them): git -C ${P} diff ${BASE}...${SNAP} (--stat first). Also check whether the work is ALREADY on ${BASE}: git -C ${P} log ${BASE} --oneline -15.
2. TEST IT in a scratch copy: rm -rf ${S} && mkdir -p ${S} && git -C ${P} archive ${SNAP} | tar -x -C ${S}. Then (unset NODE_ENV; npm ci --include=dev) and npx prisma generate if there is a Prisma schema.${dbSetup ? ` Then give it a real, seeded database (git archive leaves out the untracked DB file, so without this the app runs on an empty database; do the same in any ${BASE} copy): (cd ${S} && ${dbSetup})` : ""} Run the typecheck/test/build scripts that exist, and where something fails compare against a ${BASE} copy (git -C ${P} archive ${BASE} into ${S}-${BASE}), so pre-existing ${BASE} bugs aren't blamed on this card. Never symlink or touch ${P}/node_modules.
3. VISUAL QA, required if the card touches UI: anything in the diff under src/ (pages, components, styles; test-only files don't count), *.css, tailwind/postcss config, or public/. Otherwise visual = "n/a".
   a. Routes: every page the diff adds or changes (src/app/**/page.tsx → its route; for dynamic segments use a real slug/id from the seeded DB or the API). Capture each at mobile (375x667) and desktop (1280x720), and script at least one interaction per interactive feature (fill/click/waitFor, then screenshot).
   b. Use the project's browser tooling (see its AGENTS.md), run FROM ${P} and pointed AT the scratch copy with --target, so it serves the card's code, not ${BASE}: cd ${P} && npm run screenshot -- <route> --target ${S} --viewport mobile --out ${OUT}/<name>-mobile.png (then desktop), and cd ${P} && npm run browse -- ${OUT}/<flow>.json --target ${S}. The tool starts the scratch copy's servers itself. Check each report's URL/outline shows the card's changes; save the text reports into ${OUT}/report.txt.
   c. If the project tooling fails, visual = "blocked" (say why). A UI card can NOT pass without visual evidence: if the app fails to start or render because of this card, that is BLOCKING (FAIL); if the tooling fails for reasons that also happen on ${BASE}, the verdict is STALLED (tooling: why). Never judge UI from code alone.${buildFallbackNote(input)}
   d. Errors that also happen on ${BASE} are not this card's: if the card's report shows console errors or failed requests, run the same routes on the ${BASE} copy (--target ${S}-${BASE}).${knownBaseIssues ? ` ${knownBaseIssues}` : ""}
   e. Look at the PNGs at both sizes (view_image in Codex, the Read tool in Claude): layout, overflow, the mobile nav/drawer, loading/empty/error states. Console errors CAUSED by this card are BLOCKING.
   f. USE IT like a customer: for each requirement with a user-facing flow (log in/out, register, search/filter, add to cart, checkout, admin edits), script the whole journey with npm run browse and check the RESULT (logged-in state shows, cart count changes, the order appears, the edit persists after a reload), not just that each page renders. Empty lists, "0 results", spinners that never resolve, 401/429/500 responses and error banners where the seeded data should show are bugs: find out whether this card or ${BASE} causes them before you pass anything.
   g. Do NOT run npm run preview, preview:stop, dev or dev:servers anywhere (preview:stop stops the user's shared preview). Leave the scratch servers running: the orchestrator stops them after your verdict.${extra}
4. JUDGE it against the requirements below. BLOCKING = a core requirement missing or broken (including a user journey from 3f that doesn't work end to end), NEW typecheck/test/build failures or console errors caused by this card, a security hole, or a regression. Everything else is a non-blocking concern. SCORE each 0-5 (5 excellent, 3 acceptable with real issues, 0 missing): spec, correctness, tests (quality/coverage of new tests, and do they pass), ux (UI cards only, else null), code (structure, types, readability), process (followed the card's instructions: changes left uncommitted in the worktree, scoped diff, no unrelated files, tests run).
5. Write each blocking issue so the dev can act on it alone: what is wrong, where (file/route), and how to reproduce or check it. EVIDENCE: every blocking issue must quote the exact command (or browse script / screenshot) that shows it and the relevant lines of its output, saved under OUT. Re-run it once before you report: if it no longer reproduces (e.g. a test that passes on rerun), it is a non-blocking concern, not a blocker. A claim you cannot back with output is not blocking.
6. REPORT: write ${OUT}/verdict.json (valid JSON, double quotes) with exactly these keys:
   {"verdict":"PASS|FAIL|STALLED","scores":{"spec":n,"correctness":n,"tests":n,"ux":n|null,"code":n,"process":n} or null for STALLED,"blocking":["…"],"visual":{"status":"ok|blocked|n/a","artifacts":["report.txt","<name>-mobile.png",…],"consoleErrors":<card-caused count>},"notes":"<one line>","log":"<markdown bullets: blocking issues; fixed since last round; concerns; visual summary (card-caused vs pre-existing errors)>"}
   Artifact paths are relative to OUT. This file IS your verdict: the orchestrator records it, and on PASS lands the card / on FAIL sends your blocking list back to the same dev.
7. Finish by replying with one line: "QA ${input.devTaskId} round ${input.round}: PASS|FAIL|STALLED, report in ${OUT}/verdict.json". Do nothing else.

Dev card ${input.devTaskId} requirements:
"""
${input.requirements}
"""`;
}

/** The QA card's title: `QA <dev>: …` for round 1, `QA<n> <dev>: …` after (the legacy kit's titles). */
export function buildQaCardTitle(devTaskId: string, round: number, devTitle: string): string {
	return `QA${round > 1 ? round : ""} ${devTaskId}: ${getQaShortTitle(devTitle)}`;
}
