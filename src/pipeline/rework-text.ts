// The texts of the rework loop (src/pipeline/rework.ts): the REWORK section a failed card gets back, the prompt of
// a sibling card that takes over an escalated task on another model, and the preserve tag of the work it replaces.
// Pure: the caller reads the QA log, the stale-base check and the staged QA notes and passes them in.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (reworkText, withRework, modelSlug) and
// @b6bbe71 (the QA write-up is staged in the worktree as `.qa/r<N>/`: card agents never need the Kanban home).
import type { EffectiveModel } from "../core/effective-agent";
import { BLOCKED_TITLE_PREFIX } from "./actions";

const MAX_QA_DETAILS_CHARS = 4000;
const FINAL_STEP = /\n+FINAL STEP/u;

export interface ReworkConflict {
	baseRef: string;
	files: string[];
}

export interface StaleBase {
	/** The worktree's HEAD, an ancestor of the base tip. */
	head: string;
	tip: string;
}

export interface ReworkTextInput {
	taskId: string;
	/** The QA round that failed. */
	round: number;
	verdict: string;
	blocking: string[];
	/** The dev card's QA log section for that round ("## Claude QA …"), or "". */
	qaSection: string;
	conflict: ReworkConflict | null;
	/** Which rework this is (1 = the first) and the FAIL rounds after which the card goes to a human. */
	reworkNumber: number;
	maxFailRounds: number;
	baseRef: string;
	repoPath: string;
	staleBase: StaleBase | null;
	/** `.qa/r<N>` in the worktree when the QA notes were copied there, else null. */
	stagedNotes: string | null;
	qaLogPath: string;
	artifactsDir: string;
	/** Epoch ms. */
	now: number;
}

/** The "Blocking" bullets of a QA log section ("- Blocking: …" or a "- **Blocking**" header with indented lines). */
export function readBlockingBullets(section: string): string[] {
	const lines = section.split("\n");
	const start = lines.findIndex((line) => /^\s*-\s*\**Blocking\b/iu.test(line));
	if (start < 0) {
		return [];
	}
	const head = (lines[start] ?? "").replace(/^\s*-\s*\**Blocking\**:?\**\s*/iu, "").trim();
	const bullets = head ? [`- ${head}`] : [];
	for (const line of lines.slice(start + 1)) {
		if (!/^\s+\S/u.test(line)) {
			break;
		}
		bullets.push(line.replace(/^\s{2}/u, ""));
	}
	return bullets;
}

/**
 * The line that tells a dirty worktree behind its base to bring the base in first (a3f076e: c1e30/de30c 10/05, QA
 * compared against a newer base and read the card as deleting everything that landed since).
 */
export function buildStaleBaseLine(baseRef: string, stale: StaleBase): string {
	return `FIRST bring current ${baseRef} into your worktree (it is based on an older ${baseRef}, ${stale.head.slice(0, 8)}; ${baseRef} is now ${stale.tip.slice(0, 8)}): git stash -u && git checkout --detach ${baseRef} && git stash pop. On conflicts keep ${baseRef}'s version of files that already exist there and re-apply only your own changes. Without this QA sees your diff as deleting everything that landed since.`;
}

export function buildReworkText(input: ReworkTextInput): string {
	const next = input.round + 1;
	const stamp = new Date(input.now).toISOString().slice(0, 16);
	const lines = [
		...(input.staleBase ? [buildStaleBaseLine(input.baseRef, input.staleBase)] : []),
		`REWORK round ${next} (QA round ${input.round}: ${input.conflict ? "PASS, but it does not merge" : input.verdict}; ${stamp}Z, from Kanban)`,
		`QA did not accept your last submission. Fix the blocking issues below in this same worktree, keep what already works, re-run the tests, and leave your changes in the worktree as before (do not commit or cherry-pick into ${input.repoPath}, and do not touch other cards). Then finish exactly like the original task, including its FINAL STEP if it has one. This is rework ${input.reworkNumber} of at most ${Math.max(input.maxFailRounds - 1, input.reworkNumber)}; after ${input.maxFailRounds} failed QA rounds the card goes to a human.`,
	];
	if (input.conflict) {
		const { baseRef, files } = input.conflict;
		lines.push(
			`Blocking: rebase onto ${baseRef}: conflicts in ${files.join(", ")}.`,
			`Your work does not merge cleanly into ${baseRef}. Bring the worktree up to date with ${baseRef} (git merge ${baseRef}, or rebase onto it), resolve the conflicts in those files keeping ${baseRef}'s changes unless they contradict your task, and re-run the tests. QA already passed the work itself.`,
		);
	} else {
		lines.push(
			"Blocking (from QA):",
			...(input.blocking.length > 0
				? input.blocking.map((item) => `- ${item}`)
				: ["- (none listed in the verdict; see the QA write-up)"]),
		);
		const details = readBlockingBullets(input.qaSection).join("\n").slice(0, MAX_QA_DETAILS_CHARS);
		if (details) {
			lines.push("QA details:", details);
		}
	}
	if (input.stagedNotes) {
		lines.push(
			`QA write-up and artifacts (screenshots, reports) for round ${input.round}: ${input.stagedNotes}/ in your worktree (start with ${input.stagedNotes}/QA.md). It is git-ignored; leave it there.`,
		);
	} else {
		lines.push(
			`QA write-up: the "## Claude QA ${input.taskId}${input.round > 1 ? ` (round ${input.round})` : ""}" section of ${input.qaLogPath}. QA artifacts (screenshots, reports): ${input.artifactsDir}/`,
		);
	}
	return lines.join("\n");
}

/**
 * Adds a section before the prompt's FINAL STEP, so the agent still ends with it and the next QA round (whose
 * requirements are the prompt cut at FINAL STEP) sees the section as part of the task.
 */
export function insertBeforeFinalStep(prompt: string, section: string): string {
	const at = prompt.search(FINAL_STEP);
	if (at < 0) {
		return `${prompt.trimEnd()}\n\n${section}`;
	}
	return `${prompt.slice(0, at).trimEnd()}\n\n${section}\n\n${prompt.slice(at).trimStart()}`;
}

/** After `/clear` the agent no longer remembers the task: it gets the whole card prompt (task + REWORK section). */
export function buildClearedReworkMessage(prompt: string): string {
	return `${prompt}\n\nYour conversation was cleared to save context; your previous work is in this worktree (git status / git diff). Do the REWORK section above.`;
}

/** A model id as a tag or title part: `us.openai.gpt-6.1-sol` → `gpt-6.1-sol`. */
export function modelSlug(model: string | null | undefined): string {
	return String(model || "unknown")
		.replace(/^(?:us|global|eu|apac)\./u, "")
		.replace(/^[a-z]+\.(?=.)/u, "")
		.replace(/[^\w.-]+/gu, "-");
}

/** Where an escalated card's work is kept when a sibling card takes the task over (`preserve/<id>-<model>`). */
export function buildPreserveTag(taskId: string, model: string | null | undefined): string {
	return `preserve/${taskId}-${modelSlug(model)}`;
}

export function stripBlockedPrefix(title: string): string {
	return title.startsWith(BLOCKED_TITLE_PREFIX) ? title.slice(BLOCKED_TITLE_PREFIX.length) : title;
}

export interface SiblingPromptInput {
	/** The original card's prompt (REWORK sections included: they are QA's notes on the task). */
	prompt: string;
	fromTaskId: string;
	from: { agentId: string; model: EffectiveModel | null };
	reason: string;
	tag: string;
	blocking: string[];
	now: number;
}

/** The prompt of a sibling card that takes over an escalated task on another model. */
export function buildSiblingPrompt(input: SiblingPromptInput): string {
	const stamp = new Date(input.now).toISOString().slice(0, 16);
	const model = input.from.model ? ` on ${input.from.model.model}` : "";
	const lines = [
		`ESCALATED FROM ${input.fromTaskId} (${input.reason}; ${stamp}Z, from Kanban)`,
		`Card ${input.fromTaskId} worked on this task with ${input.from.agentId}${model} and did not get through QA. Do the task in your own worktree, starting from the base as usual.`,
		`Its work is kept at git tag ${input.tag} for reference (git show ${input.tag}).`,
		...(input.blocking.length > 0
			? ["What QA found in its last round:", ...input.blocking.map((item) => `- ${item}`)]
			: []),
	];
	return insertBeforeFinalStep(input.prompt, lines.join("\n"));
}
