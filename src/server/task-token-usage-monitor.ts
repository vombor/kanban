// Pushes the board cards' token counts live (user request 2026-10-12): while a browser follows a workspace, a card
// session's activity (a summary change: a hook, a state change) and, every `throttleMs`, a card session that is
// running (its output alone changes no summary) re-read the workspace's counts, at most once per `throttleMs`; the
// cards whose counts changed go to that workspace's clients only (`task_token_usage_updated`, never on the project
// list, since they are card data). The browser fetches the whole list itself on load
// (workspace.getTaskTokenUsage), so nothing is pushed without a client. An agent writes its session file just after
// the output that changed its summary, so a read whose counts moved, or that saw activity while it ran, reads once more
// a throttle later, until the counts hold still.
import type { RuntimeTaskTokenUsage } from "../core/api-contract";
import { isDetailTerminalTaskId } from "../core/detail-terminal-session";
import { isHomeAgentSessionId } from "../core/home-agent-session";

export const TASK_TOKEN_USAGE_PUSH_THROTTLE_MS = 5_000;

/** A card's own agent session: not a sidebar orchestrator or a card's detail terminal. */
export function isTaskTokenUsageSession(sessionId: string): boolean {
	return !isHomeAgentSessionId(sessionId) && !isDetailTerminalTaskId(sessionId);
}

export interface TaskTokenUsageMonitorDependencies {
	/** The workspace's counts (src/server/task-token-usage.ts); null when the workspace is gone. */
	loadUsage: (workspaceId: string) => Promise<RuntimeTaskTokenUsage[] | null>;
	hasClients: (workspaceId: string) => boolean;
	/** Workspaces with a client and a card session that is running: swept every `throttleMs`. */
	listRunningWorkspaces: () => string[];
	broadcast: (workspaceId: string, usage: RuntimeTaskTokenUsage[]) => void;
	throttleMs?: number;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface TaskTokenUsageMonitor {
	/** A session of the workspace changed (`taskId`: its session id); the workspace's counts are re-read soon. */
	noteActivity: (workspaceId: string, taskId: string) => void;
	forgetWorkspace: (workspaceId: string) => void;
	close: () => void;
}

interface WorkspaceState {
	timer: NodeJS.Timeout | null;
	reading: boolean;
	/** Activity since the last read started. */
	dirty: boolean;
	lastReadAt: number;
	/** The counts as last sent (or read), per card. */
	sent: Map<string, RuntimeTaskTokenUsage>;
}

function isSameUsage(a: RuntimeTaskTokenUsage | undefined, b: RuntimeTaskTokenUsage): boolean {
	return (
		a !== undefined &&
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite
	);
}

export function createTaskTokenUsageMonitor(deps: TaskTokenUsageMonitorDependencies): TaskTokenUsageMonitor {
	const throttleMs = deps.throttleMs ?? TASK_TOKEN_USAGE_PUSH_THROTTLE_MS;
	const now = deps.now ?? Date.now;
	const states = new Map<string, WorkspaceState>();
	let closed = false;
	let sweep: NodeJS.Timeout | null = null;

	const schedule = (workspaceId: string, state: WorkspaceState) => {
		if (closed || state.timer || state.reading) {
			return;
		}
		const delay = Math.max(0, state.lastReadAt + throttleMs - now());
		state.timer = setTimeout(() => {
			state.timer = null;
			void read(workspaceId, state);
		}, delay);
		state.timer.unref?.();
	};

	const read = async (workspaceId: string, state: WorkspaceState) => {
		if (closed || states.get(workspaceId) !== state || !deps.hasClients(workspaceId)) {
			return;
		}
		state.reading = true;
		state.dirty = false;
		state.lastReadAt = now();
		let changed: RuntimeTaskTokenUsage[] = [];
		try {
			const usage = await deps.loadUsage(workspaceId);
			if (usage === null) {
				states.delete(workspaceId);
				return;
			}
			changed = usage.filter((entry) => !isSameUsage(state.sent.get(entry.taskId), entry));
			for (const entry of changed) {
				state.sent.set(entry.taskId, entry);
			}
			if (changed.length > 0 && !closed) {
				deps.broadcast(workspaceId, changed);
			}
		} catch (error) {
			deps.warn?.(
				`Token counts of ${workspaceId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			state.reading = false;
		}
		if (state.dirty || changed.length > 0) {
			schedule(workspaceId, state);
		}
	};

	const markDirty = (workspaceId: string) => {
		if (closed || !deps.hasClients(workspaceId)) {
			return;
		}
		let state = states.get(workspaceId);
		if (!state) {
			state = { timer: null, reading: false, dirty: false, lastReadAt: 0, sent: new Map() };
			states.set(workspaceId, state);
		}
		state.dirty = true;
		schedule(workspaceId, state);
	};

	sweep = setInterval(() => {
		try {
			for (const workspaceId of deps.listRunningWorkspaces()) {
				markDirty(workspaceId);
			}
		} catch (error) {
			deps.warn?.(`Token count sweep failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, throttleMs);
	sweep.unref?.();

	return {
		noteActivity: (workspaceId, taskId) => {
			if (isTaskTokenUsageSession(taskId)) {
				markDirty(workspaceId);
			}
		},
		forgetWorkspace: (workspaceId) => {
			const state = states.get(workspaceId);
			if (state?.timer) {
				clearTimeout(state.timer);
			}
			states.delete(workspaceId);
		},
		close: () => {
			closed = true;
			if (sweep) {
				clearInterval(sweep);
				sweep = null;
			}
			for (const state of states.values()) {
				if (state.timer) {
					clearTimeout(state.timer);
				}
			}
			states.clear();
		},
	};
}
