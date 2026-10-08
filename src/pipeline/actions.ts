// Card actions the pipeline worker asks the Kanban server for: the QA gate creates and starts QA cards, restart
// recovery resumes orphaned cards, and the rework stage updates, resumes and blocks dev cards and creates sibling
// cards; the issue import's sync job applies fetched issues to the board (`applyIssues`, src/issues/).
// They travel as worker `request`s next to the watchdog's actions (worker-protocol.ts); finishing a card is the
// `finishTask` request (the Done workflow) and typing into one is the watchdog's `deliverInput`. The worker never
// writes the board or touches a session itself: the server stays the only writer (plan §5), and each request runs
// through the same code the CLI and the browser use (src/server/pipeline-actions.ts).
import type { RuntimeAgentId, RuntimeTaskAgentSettings, RuntimeTaskIssue, RuntimeTaskRole } from "../core/api-contract";
import type { IssueApplyInput, IssueApplyResult } from "../issues/issue-apply";

/** The title prefix of an escalated card parked in Backlog (the legacy kit's, which people and the watchdog read). */
export const BLOCKED_TITLE_PREFIX = "BLOCKED: ";

interface PipelineActionScope {
	workspaceId: string;
	workspacePath: string;
}

export interface PipelineCreateTaskInput {
	/** Chosen by the worker so the prompt can name it (a QA card's outbox is `<outboxRoot>/<its id>`). */
	taskId: string;
	title: string;
	prompt: string;
	role: RuntimeTaskRole;
	reviewsTaskId?: string;
	agentId: RuntimeAgentId;
	agentSettings?: RuntimeTaskAgentSettings;
	baseRef: string;
	/** A rework sibling of an imported card carries its issue (`Fixes #N`, the land comment). */
	issue?: RuntimeTaskIssue;
}

export type PipelineActionRequest =
	/** Adds a card to Backlog (never auto-reviewed). */
	| (PipelineActionScope & { kind: "createTask"; task: PipelineCreateTaskInput })
	/** Backlog → In Progress with a fresh session, as `kanban task start` does. */
	| (PipelineActionScope & { kind: "startTask"; taskId: string })
	/**
	 * A new session on `agentId` with the card's own model settings for an In Progress or Review card, then In
	 * Progress: restart recovery (recovery-stage.ts) for a card whose session died with the old server, and the rework
	 * stage for a rework that has no session to type into or never started. `prompt` absent = the card's current
	 * prompt. A card with a live session is refused, unless `replaceLive` (the rework started-check: the live session
	 * never took the rework), which stops it first; the card moves only once a new session has started.
	 * `continueConversation` (restart recovery only, for an agent whose resume continues its conversation; see
	 * buildRestartResumeLaunch) starts with `resumeFromTrash`, so `prompt` is the next turn of the old conversation
	 * (the resume note), never the card prompt. The rework stage never sets it, `replaceLive` included: the session it
	 * replaces never took the rework, so a fresh session gets the reworked card prompt instead of a conversation that
	 * carries the context the rework round meant to leave behind.
	 */
	| (PipelineActionScope & {
			kind: "resumeTask";
			taskId: string;
			prompt?: string;
			agentId: RuntimeAgentId;
			replaceLive?: boolean;
			continueConversation?: boolean;
	  })
	/** Replaces a card's prompt and/or title (the rework stage's REWORK section). */
	| (PipelineActionScope & { kind: "updateTask"; taskId: string; prompt?: string; title?: string })
	/** An escalated card leaves Review / In Progress for Backlog with a `BLOCKED: ` title prefix (kept once). */
	| (PipelineActionScope & { kind: "blockTask"; taskId: string })
	/**
	 * The issue import's fetched issues (src/issues/issue-sync.ts): the server creates, updates and marks cards under
	 * the board lock (src/issues/issue-apply.ts). Only for a workspace whose `issues.mode` is `on`; never starts a card.
	 */
	| (PipelineActionScope & { kind: "applyIssues"; issues: Omit<IssueApplyInput, "workspaceId" | "workspacePath"> });

export type PipelineActionResult =
	| { ok: true; detail?: string; issues?: IssueApplyResult }
	| { ok: false; error: string };

export interface PipelineActions {
	run: (request: PipelineActionRequest) => Promise<PipelineActionResult>;
}
