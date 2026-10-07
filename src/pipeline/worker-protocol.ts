// Messages between the Kanban server and the pipeline worker (a child process, plan §5), over Node's IPC channel.
// The server owns the board and the sessions and sends the worker snapshots; the worker decides and logs. Once
// stages act (later cards), the worker asks the server to act through requests added here, so the server stays
// the only writer of the board.
import type { PipelineWorkspaceSnapshot } from "./engine";

export type PipelineHostMessage =
	| { type: "snapshot"; snapshot: PipelineWorkspaceSnapshot }
	/** The workspace left the server (project removed) or no longer runs the pipeline. */
	| { type: "forget"; workspaceId: string }
	| { type: "shutdown" };

export type PipelineWorkerMessage =
	| { type: "ready"; pid: number }
	| { type: "evaluated"; workspaceId: string; decisions: number; logged: number }
	| { type: "log"; message: string };

function hasType(value: unknown): value is { type: unknown } {
	return Boolean(value) && typeof value === "object" && "type" in (value as object);
}

export function isPipelineHostMessage(value: unknown): value is PipelineHostMessage {
	return hasType(value) && (value.type === "snapshot" || value.type === "forget" || value.type === "shutdown");
}

export function isPipelineWorkerMessage(value: unknown): value is PipelineWorkerMessage {
	return hasType(value) && (value.type === "ready" || value.type === "evaluated" || value.type === "log");
}
