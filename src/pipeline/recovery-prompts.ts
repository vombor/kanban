// The texts recovery types into a card's agent. Kept word for word from the legacy kit where the wording carried a
// lesson (the "no images" and output-cap notes, the overflow search hint, the restart WIP note).
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (nudgeIfErrored, sendDueRetry) and
// archive/devteam-kit:lib/resume.mjs@6da71597 (WIP_NOTE) and kit main a2b4695 lib/resume.mjs (RESUME_NOTE).
import type { RuntimeAgentId } from "../core/api-contract";
import type { ClineSilentStall } from "../terminal/cline-turn-check";
import { agentContinuesConversationOnResume } from "../terminal/orchestrator-agents";
import { OUTPUT_CAP_TOKENS, type PrematureStop } from "./recovery-detect";

export const CONTINUE_PROMPT =
	"Continue: do that now (call the tool). Keep going until the whole task is done; only stop when you're finished.";

// 219fc1b: only when the worktree has changes. A note on a clean worktree made the agent search other worktrees.
export const RESTART_WIP_NOTE =
	"NOTE (Kanban): Kanban restarted while you were working on this card, so your previous session was lost. Your work in progress is still in this worktree: run git status and git diff first, review what is there, and continue from it. Do not start over or discard it.";

// kit main a2b4695 (kanban-2uge, 10/07): the launch prompt of a resume that continues the conversation. The card
// prompt there would hand the agent its whole task again as a new turn, inviting it to redo finished work.
export const RESTART_RESUME_NOTE =
	"NOTE (orchestrator): you were resumed after a container/Kanban restart that ended your previous session. Pick up where you left off (check git status and git diff if unsure what you already did), finish the card, and end with a STATUS line.";

/** Between the clear command and the text that follows it, so the TUI has started the new conversation. */
export const CLEAR_SETTLE_MS = 1_500;

/**
 * Issue #12: an image over the provider's size limits (Anthropic/Bedrock: 8000 px on a side, 5 MB; 2000 px once a
 * request carries many images). Also appended to the prompt of a QA card recreated after that error (qa-gate.ts).
 */
export const IMAGE_TOO_LARGE_NOTE =
	"Your previous conversation was cleared: you opened an image larger than the model accepts (over 8000 pixels on a side, or over 5 MB), and every later request failed.";
export const SMALL_IMAGES_ONLY =
	"Never open a full-page screenshot or any image taller or wider than 2000 pixels: take viewport-sized screenshots (no --full-page), and check pages through the screenshot tool's text report (status, console, outline) instead.";

const WORK_IS_HERE = "Your work so far is in this worktree (git status / git diff): continue the task from there.";

/** The card prompt resent after /clear for a premature stop that poisoned the history. */
export function buildClearedPrematurePrompt(
	cardPrompt: string,
	stop: Exclude<PrematureStop, { kind: "announcement" }>,
): string {
	if (stop.kind === "no_images" && stop.tooLarge) {
		return `${cardPrompt}\n\n${IMAGE_TOO_LARGE_NOTE} ${WORK_IS_HERE} ${SMALL_IMAGES_ONLY}`;
	}
	if (stop.kind === "no_images") {
		return `${cardPrompt}\n\nYour previous conversation was cleared: you opened an image file, your model doesn't accept images, and every later request failed. ${WORK_IS_HERE} Never read image files (.png/.jpg/.gif/.webp); check screenshots through the screenshot tool's text report (status, console, outline) instead.`;
	}
	const cap = stop.outputCap
		? ` That reply hit the ${OUTPUT_CAP_TOKENS}-token output limit and was lost: keep every tool call under about 200 lines, and write big files in parts (create, then add with edits).`
		: "";
	return `${cardPrompt}\n\nYour previous conversation ended on an empty model reply and was cleared. ${WORK_IS_HERE}${cap}`;
}

export interface OverflowNote {
	culprit: { size: number; query: string | null } | null;
	cleanedDirs: string[];
}

function describeOverflow(note: OverflowNote): string {
	let text = "";
	if (note.culprit) {
		const query = note.culprit.query ? ` (\`${note.culprit.query}\`)` : "";
		text += ` The cause: one tool call returned ${Math.round(note.culprit.size / 1024)} KB${query}. Don't repeat it.`;
	}
	if (note.cleanedDirs.length > 0) {
		text += ` Generated reports (${note.cleanedDirs.join(", ")}) were deleted from the worktree; they are gitignored and huge.`;
	}
	return `${text} Search with \`git grep -n <pattern> -- src server e2e\` (it skips ignored files) and pipe long output through | head -100.`;
}

/** After a fatal API error that poisoned the history: the card prompt, resent after /clear. */
export function buildPoisonedHistoryPrompt(cardPrompt: string, error: string, overflow: OverflowNote | null): string {
	const note = overflow ? describeOverflow(overflow) : "";
	return `${cardPrompt}\n\nYour previous conversation hit a fatal API error (${error.slice(0, 200)}) and was cleared.${note} ${WORK_IS_HERE}`;
}

/** A crash nudge for a turn that stopped on an error that did not poison the history. */
export function buildCrashNudgePrompt(reason: string, error: string): string {
	return `Your previous turn stopped (${reason}${error ? `: ${error.slice(0, 200)}` : ""}). Continue the task; your work so far is in this worktree.`;
}

/**
 * The nudge for a silent stall (recovery.ts): a step that never returned gets told so, since a plain "continue" left
 * the agent waiting on a result that would never come; any other stall gets the usual continue.
 */
export function buildSilentStallPrompt(stall: Pick<ClineSilentStall, "kind" | "tools">): string {
	if (stall.kind !== "interrupted_tool") {
		return CONTINUE_PROMPT;
	}
	const tools = stall.tools.length > 0 ? ` (${stall.tools.join(", ")})` : "";
	return `Your last tool call${tools} didn't return: it was interrupted and no result came back. Check the worktree (git status / git diff) to see whether it took effect, then re-run it or continue. Keep going until the whole task is done; only stop when you're finished.`;
}

/** The continue sent once a provider-error backoff (or an outage hold) is over. */
export function buildProviderRetryPrompt(error: string): string {
	return `Your previous turn stopped on a provider error (${error.slice(0, 200)}). The service should be back now: continue the task; your work so far is in this worktree.`;
}

/** The prompt a resumed card starts with: its own prompt, plus the WIP note only when the worktree has changes. */
export function buildResumePrompt(cardPrompt: string, hasWorkInProgress: boolean): string {
	return hasWorkInProgress ? `${cardPrompt}\n\n${RESTART_WIP_NOTE}` : cardPrompt;
}

export interface RestartResumeLaunch {
	prompt: string;
	/** Start with `resumeFromTrash`: the agent continues its last conversation in the worktree. */
	continueConversation: boolean;
}

/**
 * How a card whose session died with a restart starts again: an agent that can continue its conversation gets the
 * resume note as its launch prompt (no WIP note: the conversation knows its own work), every other agent (Cline among
 * them) a new session with buildResumePrompt(). The board card's prompt is never changed.
 */
export function buildRestartResumeLaunch(
	agentId: RuntimeAgentId,
	cardPrompt: string,
	hasWorkInProgress: boolean,
): RestartResumeLaunch {
	return agentContinuesConversationOnResume(agentId)
		? { prompt: RESTART_RESUME_NOTE, continueConversation: true }
		: { prompt: buildResumePrompt(cardPrompt, hasWorkInProgress), continueConversation: false };
}
