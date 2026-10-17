// Kanban's own typed input never lands in the user's half-written message (issue #35). deliverTaskInput refuses to
// type while the user is typing in a terminal (TerminalSessionManager.hasTypedInputSinceEnter: nothing typed since
// the last Enter and no keystroke within its quiet time, the rule orchestrator message notices use too); this hold is
// how Kanban's own deliveries that must still arrive wait for the user instead:
//   - the watchdog's sidebar wakes (src/pipeline/watchdog/wake.ts): one hold per workspace's sidebar; wakes that
//     arrive while one is held are merged into it and typed once as one line;
//   - the pipeline's deliveries into a card (recovery's nudges and resends, the rework stage, the QA gate's verdict
//     nudges, all through the watchdog's `deliverInput` request): one hold per card session, the texts kept apart and
//     typed one by one in order (a `/clear` and the message after it must stay two inputs), `itemSettleMs` apart.
// A held delivery is answered `queued` (nothing typed yet). The pipeline reads `describe()` through its snapshot
// (`heldInputSince`, `heldInputTypedAt`), so recovery and the rework stage count a held message as sent only once it
// has been typed. A request that must not wait (`kanban task send`) goes through `deliverUnlessBusy`, which refuses
// while the user is typing (deliverTaskInput's `user_typing`) or held input for that session waits (`busy`).
// A held card item is dropped as soon as its session has no process (its text was for that process) or after
// `maxHoldMs`; a held wake whose sidebar has gone is kept for `maxHoldMs`. Each drop is logged: by then recovery or
// the watchdog decides again on whatever still needs it. Unlike notices, nothing here waits for a settled Review: the
// input was typed into running sessions before, and still is.
import type { RuntimeTaskInputDeliveryResponse } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { CLEAR_SETTLE_MS } from "../pipeline/recovery-prompts";
import { type DeliverTaskInputOptions, deliverTaskInput, type TaskInputTerminal } from "../terminal/deliver-task-input";
import type { TerminalSessionManager } from "../terminal/session-manager";

export type TypedInputTerminal = TaskInputTerminal & Pick<TerminalSessionManager, "hasLiveProcess">;

export interface TypedInputHoldDependencies {
	/** The workspace's terminal manager, or null when it isn't loaded. */
	getTerminal: (workspaceId: string) => TypedInputTerminal | null;
	deliver?: (
		terminal: TypedInputTerminal,
		taskId: string,
		text: string,
		options?: DeliverTaskInputOptions,
	) => Promise<RuntimeTaskInputDeliveryResponse>;
	log: (message: string) => void;
	now?: () => number;
	/** How long a hold waits: for a sidebar that has gone, or for a card's user to finish. */
	maxHoldMs?: number;
	/** Pause between two held items typed into the same card (a `/clear` then its message). */
	itemSettleMs?: number;
}

/** What the pipeline sees of one session's hold (PipelineSessionView `heldInputSince` / `heldInputTypedAt`). */
export interface TypedInputHoldView {
	/** Since when Kanban input for the session has been held, or null (nothing held). */
	heldSince: number | null;
	/** When held input was last typed into the session, or null. */
	typedAt: number | null;
}

export interface TypedInputHold {
	/** Types the input now, or holds it (after any input already held for the session) and answers `queued`. */
	deliver: (workspaceId: string, taskId: string, text: string) => Promise<RuntimeTaskInputDeliveryResponse>;
	/**
	 * Types the input now, or refuses: `user_typing` while the user is typing there, `busy` while held input for the
	 * session waits or is being typed. Never holds.
	 */
	deliverUnlessBusy: (
		terminal: TypedInputTerminal,
		workspaceId: string,
		taskId: string,
		text: string,
		options?: DeliverTaskInputOptions,
	) => Promise<RuntimeTaskInputDeliveryResponse>;
	/** Types held input whose user has stopped typing; returns how many deliveries were typed. */
	flush: () => Promise<number>;
	/** Deliveries held for the session (0: none); a sidebar's are counted per wake, before they are merged. */
	pending: (workspaceId: string, taskId: string) => number;
	describe: (workspaceId: string, taskId: string) => TypedInputHoldView;
	start: (intervalMs?: number) => void;
	close: () => void;
}

interface HeldInput {
	workspaceId: string;
	taskId: string;
	/** Sidebar wakes: merged into one line when typed. Card input: typed one item at a time. */
	merge: boolean;
	texts: string[];
	since: number;
	/** Card input: the next item waits until then (itemSettleMs after the previous one). */
	notBefore: number;
}

export const DEFAULT_TYPED_INPUT_HOLD_MAX_MS = 60 * 60_000;
/** How long describe() still reports when held input was typed (the pipeline reads it on its next snapshots). */
const TYPED_AT_KEEP_MS = 24 * 60 * 60_000;

/** One line: the held texts in order, each once. An empty text is a wake's Enter only (wake.ts `wakeEnter`). */
export function mergeHeldWakeTexts(texts: readonly string[]): string {
	return [...new Set(texts.map((text) => text.trim()).filter((text) => text.length > 0))].join(" ");
}

/** A workspace has one sidebar hold, whichever agent's session it names; each card session has its own. */
function holdKey(workspaceId: string, taskId: string): string {
	return isHomeAgentSessionId(taskId) ? `${workspaceId}\u0000sidebar` : `${workspaceId}\u0000${taskId}`;
}

function response(
	status: RuntimeTaskInputDeliveryResponse["status"],
	fields: Partial<Omit<RuntimeTaskInputDeliveryResponse, "status">> = {},
): RuntimeTaskInputDeliveryResponse {
	return {
		ok: fields.ok ?? false,
		status,
		evidence: null,
		enterAttempts: 0,
		summary: fields.summary ?? null,
		...(fields.error ? { error: fields.error } : {}),
	};
}

/** Statuses after which nothing reached the PTY. */
const NOTHING_TYPED = new Set<RuntimeTaskInputDeliveryResponse["status"]>([
	"user_typing",
	"busy",
	"queued",
	"no_session",
	"error",
]);

export function createTypedInputHold(deps: TypedInputHoldDependencies): TypedInputHold {
	const now = deps.now ?? Date.now;
	const maxHoldMs = deps.maxHoldMs ?? DEFAULT_TYPED_INPUT_HOLD_MAX_MS;
	const itemSettleMs = deps.itemSettleMs ?? CLEAR_SETTLE_MS;
	const deliver =
		deps.deliver ??
		(async (terminal, taskId, text, options) => await deliverTaskInput(terminal, taskId, text, options));
	const held = new Map<string, HeldInput>();
	/** Sessions with a delivery under way: input arriving meanwhile is held, never typed beside it. */
	const delivering = new Set<string>();
	const typedAt = new Map<string, number>();
	let timer: NodeJS.Timeout | null = null;
	let flushing: Promise<number> | null = null;

	const hold = (key: string, workspaceId: string, taskId: string, text: string): void => {
		const entry = held.get(key);
		if (entry) {
			entry.taskId = taskId;
			entry.texts.push(text);
			return;
		}
		held.set(key, {
			workspaceId,
			taskId,
			merge: isHomeAgentSessionId(taskId),
			texts: [text],
			since: now(),
			notBefore: 0,
		});
	};

	const typeInto = async (
		key: string,
		terminal: TypedInputTerminal,
		taskId: string,
		text: string,
		options?: DeliverTaskInputOptions,
	): Promise<RuntimeTaskInputDeliveryResponse> => {
		delivering.add(key);
		try {
			const result = await deliver(terminal, taskId, text, options).catch((error: unknown) =>
				response("error", { error: String(error) }),
			);
			if (!NOTHING_TYPED.has(result.status)) {
				typedAt.set(key, now());
			}
			return result;
		} finally {
			delivering.delete(key);
		}
	};

	const drop = (key: string, entry: HeldInput, why: string): void => {
		held.delete(key);
		deps.log(
			`[typed-input-hold] ${entry.workspaceId}: dropped ${entry.texts.length} input(s) held ${Math.round((now() - entry.since) / 60_000)} min for ${entry.taskId}: ${why}`,
		);
	};

	const flushOnce = async (): Promise<number> => {
		let typed = 0;
		for (const [key, at] of typedAt) {
			if (now() - at >= TYPED_AT_KEEP_MS) {
				typedAt.delete(key);
			}
		}
		for (const [key, entry] of [...held]) {
			if (delivering.has(key) || now() < entry.notBefore) {
				continue;
			}
			const terminal = deps.getTerminal(entry.workspaceId);
			if (!terminal?.hasLiveProcess(entry.taskId)) {
				if (!entry.merge) {
					drop(key, entry, "its session has no process");
				} else if (now() - entry.since >= maxHoldMs) {
					drop(key, entry, "it has no running session");
				}
				continue;
			}
			if (terminal.hasTypedInputSinceEnter(entry.taskId)) {
				if (!entry.merge && now() - entry.since >= maxHoldMs) {
					drop(key, entry, "the user kept a draft in its terminal");
				}
				continue;
			}
			const texts = entry.merge ? entry.texts.splice(0) : entry.texts.splice(0, 1);
			const text = entry.merge ? mergeHeldWakeTexts(texts) : (texts[0] ?? "");
			if (entry.texts.length === 0) {
				held.delete(key);
			}
			const result = await typeInto(key, terminal, entry.taskId, text);
			if (result.status === "user_typing" || result.status === "busy") {
				// The user started typing between the check and the delivery: back to the front of the hold.
				const current = held.get(key);
				if (current) {
					current.texts.unshift(...texts);
				} else {
					held.set(key, { ...entry, texts });
				}
				continue;
			}
			const rest = held.get(key);
			if (rest) {
				rest.notBefore = now() + itemSettleMs;
			}
			if (result.ok) {
				typed += 1;
			}
			deps.log(
				`[typed-input-hold] ${entry.workspaceId}: typed ${texts.length} held input(s) into ${entry.taskId} once the user's input cleared: ${result.status}${result.error ? ` (${result.error})` : ""}`,
			);
		}
		return typed;
	};

	const flush = async (): Promise<number> => {
		// One flush at a time: a slow delivery must not type the same held input twice.
		flushing ??= flushOnce().finally(() => {
			flushing = null;
		});
		return await flushing;
	};

	return {
		deliver: async (workspaceId, taskId, text) => {
			const terminal = deps.getTerminal(workspaceId);
			if (!terminal) {
				return response("no_session", { error: `Workspace ${workspaceId} has no terminal manager.` });
			}
			const key = holdKey(workspaceId, taskId);
			if (held.has(key) || delivering.has(key) || terminal.hasTypedInputSinceEnter(taskId)) {
				hold(key, workspaceId, taskId, text);
				return response("queued", { ok: true, summary: terminal.getSummary(taskId) });
			}
			const result = await typeInto(key, terminal, taskId, text);
			if (result.status === "user_typing" || result.status === "busy") {
				hold(key, workspaceId, taskId, text);
				return response("queued", { ok: true, summary: result.summary });
			}
			return result;
		},
		deliverUnlessBusy: async (terminal, workspaceId, taskId, text, options) => {
			const key = holdKey(workspaceId, taskId);
			if (held.has(key) || delivering.has(key)) {
				return response("busy", {
					summary: terminal.getSummary(taskId),
					error: "Kanban input for this terminal is held or being typed; nothing was typed.",
				});
			}
			return await typeInto(key, terminal, taskId, text, options);
		},
		flush,
		pending: (workspaceId, taskId) => held.get(holdKey(workspaceId, taskId))?.texts.length ?? 0,
		describe: (workspaceId, taskId) => {
			const key = holdKey(workspaceId, taskId);
			return { heldSince: held.get(key)?.since ?? null, typedAt: typedAt.get(key) ?? null };
		},
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
