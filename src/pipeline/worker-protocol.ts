// Messages between the Kanban server and the pipeline worker (a child process, plan §5), over Node's IPC channel.
// The server owns the board and the sessions and sends the worker snapshots; the worker decides and logs. When a
// stage acts, the worker asks the server through a request (`finishTask`: the Done workflow, landing included), so
// the server stays the only writer of the board; the server answers with the matching `*Result`.
import type { RuntimeTaskLandingChoice, RuntimeTaskTrashResponse } from "../core/api-contract";
import type { PipelineWorkspaceSnapshot } from "./engine";
import type { PipelineEventMap } from "./events";

/** The Done workflow for a pipeline card: `pipeline` after a QA PASS, `hold_release` from releaseHold(). */
export interface PipelineFinishTaskRequest {
	workspaceId: string;
	taskId: string;
	landing: RuntimeTaskLandingChoice;
	trigger: "pipeline" | "hold_release";
}

import type { WatchdogActionRequest } from "./watchdog/actions";

export type PipelineHostMessage =
	| { type: "snapshot"; snapshot: PipelineWorkspaceSnapshot }
	/** The workspace left the server (project removed) or no longer runs the pipeline. */
	| { type: "forget"; workspaceId: string }
	/** Kanban landed a card (any trigger); the worker emits `landed` for kit features. */
	| { type: "landed"; event: PipelineEventMap["landed"] }
	| { type: "finishTaskResult"; requestId: number; result: RuntimeTaskTrashResponse }
	/** The server's answer to a worker `request` (the watchdog's actions, src/pipeline/watchdog/actions.ts). */
	| { type: "response"; id: number; ok: true; result: unknown }
	| { type: "response"; id: number; ok: false; error: string }
	| { type: "shutdown" };

export type PipelineWorkerMessage =
	| { type: "ready"; pid: number }
	| { type: "evaluated"; workspaceId: string; decisions: number; logged: number }
	| { type: "log"; message: string }
	| { type: "finishTask"; requestId: number; request: PipelineFinishTaskRequest }
	/** The worker asks the server to act; the server answers with a `response` carrying the same id. */
	| { type: "request"; id: number; request: WatchdogActionRequest };

function hasType(value: unknown): value is { type: unknown } {
	return Boolean(value) && typeof value === "object" && "type" in (value as object);
}

export function isPipelineHostMessage(value: unknown): value is PipelineHostMessage {
	return (
		hasType(value) &&
		(value.type === "snapshot" ||
			value.type === "forget" ||
			value.type === "landed" ||
			value.type === "finishTaskResult" ||
			value.type === "response" ||
			value.type === "shutdown")
	);
}

export function isPipelineWorkerMessage(value: unknown): value is PipelineWorkerMessage {
	return (
		hasType(value) &&
		(value.type === "ready" ||
			value.type === "evaluated" ||
			value.type === "log" ||
			value.type === "finishTask" ||
			value.type === "request")
	);
}
