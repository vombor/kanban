// The QA gate's card actions: what the pipeline worker asks the Kanban server to do to create and start QA cards.
// They travel as worker `request`s next to the watchdog's actions (worker-protocol.ts); finishing a card is the
// `finishTask` request (the Done workflow) and typing into one is the watchdog's `deliverInput`. The worker never
// writes the board or touches a session itself: the server stays the only writer (plan §5), and each request runs
// through the same code the CLI and the browser use (src/server/pipeline-actions.ts).
import type { RuntimeAgentId, RuntimeTaskAgentSettings, RuntimeTaskRole } from "../core/api-contract";

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
}

export type PipelineActionRequest =
	/** Adds a card to Backlog (never auto-reviewed). */
	| (PipelineActionScope & { kind: "createTask"; task: PipelineCreateTaskInput })
	/** Backlog → In Progress with a fresh session, as `kanban task start` does. */
	| (PipelineActionScope & { kind: "startTask"; taskId: string });

export type PipelineActionResult = { ok: true; detail?: string } | { ok: false; error: string };

export interface PipelineActions {
	run: (request: PipelineActionRequest) => Promise<PipelineActionResult>;
}
