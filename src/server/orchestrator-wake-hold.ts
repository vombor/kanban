// The watchdog's sidebar wakes (src/pipeline/watchdog/wake.ts) never type into the user's half-written message
// (issue #35). A wake is typed (text + Enter, deliverTaskInput) into the workspace's orchestrator sidebar session at
// once only while the user isn't typing there (TerminalSessionManager.hasTypedInputSinceEnter: nothing typed since the
// last Enter and no keystroke within its quiet time, the rule orchestrator message notices use too). Otherwise it is
// held, one hold per workspace: wakes that arrive while one is held are merged into it, and the merged text is typed
// once as soon as the user's input clears (a short poll). The watchdog counts a held wake as delivered (status
// `queued`), so it isn't typed twice. A hold whose session has gone is kept for `maxHoldMs`, then dropped and logged:
// by then the watchdog wakes again for whatever still needs the orchestrator. Unlike notices, a wake doesn't wait for
// a settled Review: it was typed into a running orchestrator before, and still is.
import type { RuntimeTaskInputDeliveryResponse } from "../core/api-contract";
import { deliverTaskInput, type TaskInputTerminal } from "../terminal/deliver-task-input";
import type { TerminalSessionManager } from "../terminal/session-manager";

export type OrchestratorWakeTerminal = TaskInputTerminal &
	Pick<TerminalSessionManager, "hasTypedInputSinceEnter" | "hasLiveProcess">;

export interface OrchestratorWakeHoldDependencies {
	/** The workspace's terminal manager, or null when it isn't loaded. */
	getTerminal: (workspaceId: string) => OrchestratorWakeTerminal | null;
	deliver?: (
		terminal: OrchestratorWakeTerminal,
		taskId: string,
		text: string,
	) => Promise<RuntimeTaskInputDeliveryResponse>;
	log: (message: string) => void;
	now?: () => number;
	/** How long a hold waits for a session that has gone. */
	maxHoldMs?: number;
}

export interface OrchestratorWakeHold {
	/** Types the wake now, or holds it (merged with a held one) and answers `queued`. */
	deliver: (workspaceId: string, taskId: string, text: string) => Promise<RuntimeTaskInputDeliveryResponse>;
	/** Types every held wake whose user has stopped typing; returns how many were typed. */
	flush: () => Promise<number>;
	/** Wakes merged into the workspace's hold (0: none held). */
	pending: (workspaceId: string) => number;
	start: (intervalMs?: number) => void;
	close: () => void;
}

interface HeldWake {
	taskId: string;
	texts: string[];
	since: number;
}

export const DEFAULT_WAKE_HOLD_MAX_MS = 60 * 60_000;

/** One line: the held texts in order, each once. An empty text is a wake's Enter only (wake.ts `wakeEnter`). */
export function mergeHeldWakeTexts(texts: readonly string[]): string {
	return [...new Set(texts.map((text) => text.trim()).filter((text) => text.length > 0))].join(" ");
}

export function createOrchestratorWakeHold(deps: OrchestratorWakeHoldDependencies): OrchestratorWakeHold {
	const now = deps.now ?? Date.now;
	const maxHoldMs = deps.maxHoldMs ?? DEFAULT_WAKE_HOLD_MAX_MS;
	const deliver = deps.deliver ?? (async (terminal, taskId, text) => await deliverTaskInput(terminal, taskId, text));
	const held = new Map<string, HeldWake>();
	/** Workspaces with a delivery under way: a wake arriving meanwhile is held, never typed beside it. */
	const delivering = new Set<string>();
	let timer: NodeJS.Timeout | null = null;
	let flushing: Promise<number> | null = null;

	const hold = (workspaceId: string, taskId: string, text: string): void => {
		const entry = held.get(workspaceId);
		if (entry) {
			entry.taskId = taskId;
			entry.texts.push(text);
			return;
		}
		held.set(workspaceId, { taskId, texts: [text], since: now() });
	};

	const typeInto = async (
		workspaceId: string,
		terminal: OrchestratorWakeTerminal,
		taskId: string,
		text: string,
	): Promise<RuntimeTaskInputDeliveryResponse> => {
		delivering.add(workspaceId);
		try {
			return await deliver(terminal, taskId, text);
		} finally {
			delivering.delete(workspaceId);
		}
	};

	const flushOnce = async (): Promise<number> => {
		let typed = 0;
		for (const [workspaceId, entry] of [...held]) {
			if (delivering.has(workspaceId)) {
				continue;
			}
			const terminal = deps.getTerminal(workspaceId);
			if (!terminal?.hasLiveProcess(entry.taskId)) {
				if (now() - entry.since >= maxHoldMs) {
					held.delete(workspaceId);
					deps.log(
						`[watchdog-wake] ${workspaceId}: dropped a wake held ${Math.round((now() - entry.since) / 60_000)} min for ${entry.taskId}, which has no running session`,
					);
				}
				continue;
			}
			if (terminal.hasTypedInputSinceEnter(entry.taskId)) {
				continue;
			}
			held.delete(workspaceId);
			const result = await typeInto(workspaceId, terminal, entry.taskId, mergeHeldWakeTexts(entry.texts)).catch(
				(error: unknown) =>
					({
						ok: false,
						status: "error",
						evidence: null,
						enterAttempts: 0,
						summary: null,
						error: String(error),
					}) as const,
			);
			if (result.ok) {
				typed += 1;
			}
			deps.log(
				`[watchdog-wake] ${workspaceId}: typed ${entry.texts.length} held wake(s) into ${entry.taskId} once the user's input cleared: ${result.status}${result.error ? ` (${result.error})` : ""}`,
			);
		}
		return typed;
	};

	const flush = async (): Promise<number> => {
		// One flush at a time: a slow delivery must not type the same held wake twice.
		flushing ??= flushOnce().finally(() => {
			flushing = null;
		});
		return await flushing;
	};

	return {
		deliver: async (workspaceId, taskId, text) => {
			const terminal = deps.getTerminal(workspaceId);
			if (!terminal) {
				return {
					ok: false,
					status: "no_session",
					evidence: null,
					enterAttempts: 0,
					summary: null,
					error: `Workspace ${workspaceId} has no terminal manager.`,
				};
			}
			if (held.has(workspaceId) || delivering.has(workspaceId) || terminal.hasTypedInputSinceEnter(taskId)) {
				hold(workspaceId, taskId, text);
				return {
					ok: true,
					status: "queued",
					evidence: null,
					enterAttempts: 0,
					summary: terminal.getSummary(taskId),
				};
			}
			return await typeInto(workspaceId, terminal, taskId, text);
		},
		flush,
		pending: (workspaceId) => held.get(workspaceId)?.texts.length ?? 0,
		start: (intervalMs = 1_000) => {
			if (timer) {
				return;
			}
			timer = setInterval(() => {
				void flush().catch(() => 0);
			}, intervalMs);
			timer.unref();
		},
		close: () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
