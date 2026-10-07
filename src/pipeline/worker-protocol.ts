// Messages between the Kanban server and the pipeline worker (a child process, plan §5), over Node's IPC channel.
// The server owns the board and the sessions and sends the worker snapshots; the worker decides and logs. When a
// stage acts, the worker asks the server, so the server stays the only writer of the board: `finishTask` (the
// Done workflow, landing included) or a `request` (the watchdog's actions, src/pipeline/watchdog/actions.ts, and
// the pipeline's card actions, src/pipeline/actions.ts). The server answers with `finishTaskResult` / `response`.
import type { RuntimeTaskLandingChoice, RuntimeTaskTrashResponse } from "../core/api-contract";
import type { PipelineActionRequest } from "./actions";
import type { PipelineWorkspaceSnapshot } from "./engine";
import type { PipelineEventMap } from "./events";
import type { WatchdogActionRequest } from "./watchdog/actions";

/**
 * The Done workflow for a pipeline card: `pipeline` after a QA PASS (and for a QA card the QA gate has ingested),
 * `hold_release` from releaseHold().
 */
export interface PipelineFinishTaskRequest {
	workspaceId: string;
	taskId: string;
	landing: RuntimeTaskLandingChoice;
	trigger: "pipeline" | "hold_release";
}

/** What a worker `request` can ask: a watchdog action or a pipeline card action (told apart by `kind`). */
export type PipelineServerRequest = WatchdogActionRequest | PipelineActionRequest;

export type PipelineHostMessage =
	| { type: "snapshot"; snapshot: PipelineWorkspaceSnapshot }
	/** The workspace left the server (project removed) or no longer runs the pipeline. */
	| { type: "forget"; workspaceId: string }
	/** Kanban landed a card (any trigger); the worker emits `landed` for kit features. */
	| { type: "landed"; event: PipelineEventMap["landed"] }
	| { type: "finishTaskResult"; requestId: number; result: RuntimeTaskTrashResponse }
	/** The server's answer to a worker `request`. */
	| { type: "response"; id: number; ok: true; result: unknown }
	| { type: "response"; id: number; ok: false; error: string }
	| { type: "shutdown" };

export type PipelineWorkerMessage =
	| { type: "ready"; pid: number }
	| { type: "evaluated"; workspaceId: string; decisions: number; logged: number }
	| { type: "log"; message: string }
	| { type: "finishTask"; requestId: number; request: PipelineFinishTaskRequest }
	/** The worker asks the server to act; the server answers with a `response` carrying the same id. */
	| { type: "request"; id: number; request: PipelineServerRequest };

function hasType(value: unknown): value is { type: unknown } {
	return Boolean(value) && typeof value === "object" && "type" in (value as object);
}

const HOST_MESSAGE_TYPES = new Set(["snapshot", "forget", "landed", "finishTaskResult", "response", "shutdown"]);
const WORKER_MESSAGE_TYPES = new Set(["ready", "evaluated", "log", "finishTask", "request"]);

export function isPipelineHostMessage(value: unknown): value is PipelineHostMessage {
	return hasType(value) && typeof value.type === "string" && HOST_MESSAGE_TYPES.has(value.type);
}

export function isPipelineWorkerMessage(value: unknown): value is PipelineWorkerMessage {
	return hasType(value) && typeof value.type === "string" && WORKER_MESSAGE_TYPES.has(value.type);
}

const PIPELINE_ACTION_KINDS = new Set<string>([
	"createTask",
	"startTask",
	"resumeTask",
	"updateTask",
	"blockTask",
] satisfies PipelineActionRequest["kind"][]);

/** Whether a `request` is one of the pipeline's card actions (the rest are watchdog actions). */
export function isPipelineActionRequest(request: PipelineServerRequest): request is PipelineActionRequest {
	return PIPELINE_ACTION_KINDS.has(request.kind);
}
