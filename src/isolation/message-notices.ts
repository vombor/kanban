// Delivering orchestrator message notices (messages.ts) without disturbing the receiver. A notice is queued per
// receiving workspace and typed (text + Enter) into its orchestrator session only when that session's Review has
// settled (isReviewSettled, src/terminal/review-settle.ts) and nothing was typed into its TUI since the last Enter
// (TerminalSessionManager.hasTypedInputSinceEnter): Kanban can't see a TUI's input box, so a draft the user may be
// writing makes the notice wait for the next settled Review instead of being appended and submitted with it. One
// notice per settled Review (it starts a turn). `send` never waits for delivery. Sends are rate-limited per sender →
// receiver pair.
import { isReviewSettled, type ReviewSettleSession } from "../terminal/review-settle";

export interface NoticeTarget {
	taskId: string;
	summary: ReviewSettleSession;
	/** Text was typed into it since its last Enter (a possible draft in the input box). */
	hasDraft: boolean;
}

export interface MessageNoticeQueueDependencies {
	/** The receiving workspace's live orchestrator session, or null. */
	findOrchestratorSession: (workspaceId: string) => NoticeTarget | null;
	/** Types the text and presses Enter; true when the TUI took it. */
	deliver: (workspaceId: string, taskId: string, text: string) => Promise<boolean>;
	settleMs: number;
	now?: () => number;
	/** Sends allowed per sender → receiver pair within `rateWindowMs`. */
	rateLimit?: number;
	rateWindowMs?: number;
	/** Notices kept per receiver; the oldest go first (the messages stay in the inbox). */
	maxQueued?: number;
}

export interface MessageNoticeQueue {
	/** Records a send from → to; false when the pair is over its rate limit (the send is refused). */
	allowSend: (fromWorkspaceId: string, toWorkspaceId: string) => boolean;
	enqueue: (toWorkspaceId: string, notice: string) => void;
	/** Delivers at most one notice per receiver whose orchestrator is settled; returns how many were delivered. */
	flush: () => Promise<number>;
	pending: (toWorkspaceId: string) => number;
	start: (intervalMs?: number) => void;
	close: () => void;
}

export const DEFAULT_MESSAGE_RATE_LIMIT = 5;
export const DEFAULT_MESSAGE_RATE_WINDOW_MS = 10 * 60_000;

export function createMessageNoticeQueue(deps: MessageNoticeQueueDependencies): MessageNoticeQueue {
	const now = deps.now ?? Date.now;
	const rateLimit = deps.rateLimit ?? DEFAULT_MESSAGE_RATE_LIMIT;
	const rateWindowMs = deps.rateWindowMs ?? DEFAULT_MESSAGE_RATE_WINDOW_MS;
	const maxQueued = deps.maxQueued ?? 20;
	const queues = new Map<string, string[]>();
	const sends = new Map<string, number[]>();
	let timer: NodeJS.Timeout | null = null;
	let flushing: Promise<number> | null = null;

	const flushOnce = async (): Promise<number> => {
		let delivered = 0;
		for (const [workspaceId, queue] of queues) {
			const notice = queue[0];
			if (notice === undefined) {
				continue;
			}
			const target = deps.findOrchestratorSession(workspaceId);
			if (
				!target ||
				target.hasDraft ||
				target.summary?.state !== "awaiting_review" ||
				!isReviewSettled(target.summary, now(), deps.settleMs)
			) {
				continue;
			}
			if (await deps.deliver(workspaceId, target.taskId, notice).catch(() => false)) {
				queue.shift();
				delivered += 1;
			}
		}
		return delivered;
	};

	const flush = async (): Promise<number> => {
		// One flush at a time: a slow delivery must not type the same notice twice.
		flushing ??= flushOnce().finally(() => {
			flushing = null;
		});
		return await flushing;
	};

	return {
		allowSend: (fromWorkspaceId, toWorkspaceId) => {
			const key = `${fromWorkspaceId}\u0000${toWorkspaceId}`;
			const recent = (sends.get(key) ?? []).filter((at) => now() - at < rateWindowMs);
			if (recent.length >= rateLimit) {
				sends.set(key, recent);
				return false;
			}
			recent.push(now());
			sends.set(key, recent);
			return true;
		},
		enqueue: (toWorkspaceId, notice) => {
			const queue = queues.get(toWorkspaceId) ?? [];
			queue.push(notice);
			while (queue.length > maxQueued) {
				queue.shift();
			}
			queues.set(toWorkspaceId, queue);
		},
		flush,
		pending: (toWorkspaceId) => queues.get(toWorkspaceId)?.length ?? 0,
		start: (intervalMs = 5_000) => {
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
